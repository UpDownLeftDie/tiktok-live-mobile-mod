// Verifies that repeated full snapshots (an old client with no cursor) are
// served from the merged cache instead of rescanning the logs, and that the
// merged result still reflects new and edited rows.
//
// Usage: node scripts/test-snapshot-cache.mjs [baseUrl]
//
// Requires CACHE_TTL_SECONDS = 0 in quota.ts and no CF_API_TOKEN/CF_ACCOUNT_ID
// in .dev.vars, so /api/quota reports this worker's own counters.

import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const STREAM = 'snapshotcache';

const devVars = Object.fromEntries(
  readFileSync(new URL('../apps/worker/.dev.vars', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
);
const mod = {
  Authorization: `Bearer ${devVars.MOD_PASSCODE}`,
  'Content-Type': 'application/json',
};
const relay = {
  Authorization: `Bearer ${devVars.RELAY_SECRET}`,
  'Content-Type': 'application/json',
};

async function call(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function rowsRead() {
  const snap = await call('/api/quota', { headers: mod });
  if (snap.source !== 'local') {
    throw new Error('quota is reporting Cloudflare totals; drop CF_* from .dev.vars');
  }
  return snap.metrics.find((m) => m.key === 'doRowsRead')?.used ?? 0;
}

let overhead = 0;
async function measure(label, fn) {
  const before = await rowsRead();
  const out = await fn();
  const after = await rowsRead();
  const rows = Math.max(0, after - before - overhead);
  console.log(`${label.padEnd(38)} ${String(rows).padStart(6)} rows`);
  return { out, rows };
}

const fullFeed = () => call(`/api/streams/${STREAM}/live`, { headers: mod });

function postChat(i) {
  return call(`/api/streams/${STREAM}/events`, {
    method: 'POST',
    headers: relay,
    body: JSON.stringify({
      kind: 'chat',
      streamId: STREAM,
      eventId: `c-${Date.now()}-${i}`,
      username: `user${i}`,
      comment: `message ${i}`,
      createdAt: Date.now(),
    }),
  });
}

const results = [];
const check = (label, ok) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

async function main() {
  await call(`/api/streams/${STREAM}/check-in`, {
    method: 'POST',
    headers: mod,
    body: JSON.stringify({ clientId: 'snapshot-test-01' }),
  });
  for (let i = 0; i < 60; i += 1) await postChat(i);

  const a = await rowsRead();
  const b = await rowsRead();
  overhead = b - a;
  console.log(`measurement overhead: ${overhead} rows/sample\n`);

  const cold = await measure('full snapshot, cold', fullFeed);
  const warm = await measure('full snapshot, nothing changed', fullFeed);
  const warm2 = await measure('full snapshot, still nothing', fullFeed);

  check('cold snapshot actually reads the logs', cold.rows > 20);
  // The floor is the config and status reads every response needs; the point is
  // that no log rescan happens on top of them.
  check(
    'unchanged repeat costs only the envelope',
    warm.rows <= 8 && warm2.rows === warm.rows,
  );
  check(
    'repeat is far cheaper than a cold read',
    warm.rows * 10 < cold.rows,
  );

  await postChat(999);
  const afterNew = await measure('full snapshot, one new message', fullFeed);
  check('delta merge is cheap', afterNew.rows < cold.rows / 2);
  check(
    'new message present in merged snapshot',
    afterNew.out.chat.some((c) => c.comment === 'message 999'),
  );
  check(
    'older messages survive the merge',
    afterNew.out.chat.some((c) => c.comment === 'message 58'),
  );
  check(
    'snapshot stays newest-first',
    afterNew.out.chat[0].comment === 'message 999',
  );

  // The cursor must belong to the snapshot, or an incremental poll would skip rows.
  const follow = await call(
    `/api/streams/${STREAM}/live?since=${afterNew.out.cursor}`,
    { headers: mod },
  );
  check('incremental follow-up returns no gap', follow.incremental === true);

  await postChat(1000);
  const next = await call(
    `/api/streams/${STREAM}/live?since=${afterNew.out.cursor}`,
    { headers: mod },
  );
  check(
    'cursor from cached snapshot picks up later rows',
    next.chat.some((c) => c.comment === 'message 1000'),
  );

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  if (passed !== results.length) process.exitCode = 1;
}

await main();
