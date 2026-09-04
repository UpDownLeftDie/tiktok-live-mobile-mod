// Measures Durable Object rows read for the live-feed poll loop, and asserts
// that new and edited rows reach a cursor poll.
//
// Usage: node scripts/bench-live-rows.mjs [baseUrl]
//
// /api/quota is cached for a minute, so the row counts only move if you set
// CACHE_TTL_SECONDS to 0 in apps/worker/src/quota.ts for the run. The
// correctness assertions hold either way.

import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const STREAM = 'benchuser';
const CLIENT = 'bench-client-0001';

const devVars = Object.fromEntries(
  readFileSync(new URL('../apps/worker/.dev.vars', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
);
const RELAY = devVars.RELAY_SECRET;
const MOD = devVars.MOD_PASSCODE;

const mod = { Authorization: `Bearer ${MOD}`, 'Content-Type': 'application/json' };
const relay = { Authorization: `Bearer ${RELAY}`, 'Content-Type': 'application/json' };

async function call(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function rowsRead() {
  const snap = await call('/api/quota', { headers: mod });
  const metric = snap.metrics.find((m) => m.key === 'doRowsRead');
  return metric?.used ?? 0;
}

async function sendChat(i) {
  return call(`/api/streams/${STREAM}/events`, {
    method: 'POST',
    headers: relay,
    body: JSON.stringify({
      kind: 'chat',
      streamId: STREAM,
      eventId: `chat-${Date.now()}-${i}`,
      username: `viewer${i % 40}`,
      comment: `hello number ${i}`,
      userSignals: null,
      createdAt: Date.now(),
    }),
  });
}

async function sendGift(i) {
  return call(`/api/streams/${STREAM}/events`, {
    method: 'POST',
    headers: relay,
    body: JSON.stringify({
      kind: 'gift',
      streamId: STREAM,
      eventId: `gift-${Date.now()}-${i}`,
      senderUsername: `giver${i}`,
      senderNickname: `Giver ${i}`,
      giftName: 'Rose',
      giftId: 5655,
      giftCount: 1,
      diamondValue: 1,
      targetUsername: null,
      targetNickname: null,
      createdAt: Date.now(),
    }),
  });
}

// Reading the counters costs rows itself; calibrate that out.
let overhead = 0;

async function measure(label, fn) {
  const before = await rowsRead();
  const result = await fn();
  const after = await rowsRead();
  const rows = Math.max(0, after - before - overhead);
  console.log(`${label.padEnd(34)} ${String(rows).padStart(7)} rows read`);
  return result;
}

async function main() {
  await call(`/api/streams/${STREAM}/check-in`, {
    method: 'POST',
    headers: mod,
    body: JSON.stringify({ clientId: CLIENT }),
  });

  process.stdout.write('seeding 300 chat + 60 gift events... ');
  for (let i = 0; i < 300; i += 1) await sendChat(i);
  for (let i = 0; i < 60; i += 1) await sendGift(i);
  console.log('done\n');

  const a = await rowsRead();
  const b = await rowsRead();
  overhead = b - a;
  console.log(`measurement overhead: ${overhead} rows per sample\n`);

  const snapshot = await measure('1 full snapshot poll', () =>
    call(`/api/streams/${STREAM}/live`, { headers: mod }),
  );
  console.log(
    `  -> chat ${snapshot.chat.length}, gifts ${snapshot.gifts.length}, cursor ${snapshot.cursor}\n`,
  );

  let cursor = snapshot.cursor;
  await measure('20 idle incremental polls', async () => {
    for (let i = 0; i < 20; i += 1) {
      const feed = await call(`/api/streams/${STREAM}/live?since=${cursor}`, {
        headers: mod,
      });
      cursor = feed.cursor;
    }
  });

  await measure('20 polls w/ 1 new chat each', async () => {
    for (let i = 0; i < 20; i += 1) {
      await sendChat(1000 + i);
      const feed = await call(`/api/streams/${STREAM}/live?since=${cursor}`, {
        headers: mod,
      });
      if (feed.chat.length !== 1) {
        throw new Error(`expected 1 new chat row, got ${feed.chat.length}`);
      }
      cursor = feed.cursor;
    }
  });

  await measure('20 more chat events (ingest)', async () => {
    for (let i = 0; i < 20; i += 1) await sendChat(2000 + i);
  });

  const target = snapshot.gifts[0];
  await call(`/api/streams/${STREAM}/gifts/${encodeURIComponent(target.id)}`, {
    method: 'PATCH',
    headers: mod,
    body: JSON.stringify({ status: 'done' }),
  });
  const afterEdit = await call(`/api/streams/${STREAM}/live?since=${cursor}`, {
    headers: mod,
  });
  const edited = afterEdit.gifts.find((g) => g.id === target.id);
  if (edited?.alertStatus !== 'done') {
    throw new Error('gift status edit did not reach an incremental poll');
  }
  console.log('\nedited gift replayed through the cursor: ok');

  const after = await call(`/api/streams/${STREAM}/live`, { headers: mod });
  console.log(
    `\nfinal snapshot: chat ${after.chat.length}, gifts ${after.gifts.length}, events ${after.events.length}`,
  );
}

await main();
