// Exercises the post-broadcast auto-checkout and the no-op status guard.
//
// Usage: node scripts/test-auto-checkout.mjs [baseUrl]
//
// Requires AUTO_CHECKOUT_AFTER_STREAM_END_MS in stream-session.ts to be shortened
// (a few seconds) and CACHE_TTL_SECONDS in quota.ts set to 0 for the run.

import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const GRACE_MS = 3_000;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function checkIn(stream, clientId) {
  return call(`/api/streams/${stream}/check-in`, {
    method: 'POST',
    headers: mod,
    body: JSON.stringify({ clientId }),
  });
}

function postEvent(stream, event) {
  return call(`/api/streams/${stream}/events`, {
    method: 'POST',
    headers: relay,
    body: JSON.stringify({ streamId: stream, ...event }),
  });
}

const streamEnd = (stream) =>
  postEvent(stream, {
    kind: 'room',
    eventId: `end-${Date.now()}`,
    type: 'stream_end',
    username: stream,
    summary: 'Stream ended',
    createdAt: Date.now(),
  });

const status = (stream, value, detail) =>
  postEvent(stream, { kind: 'status', status: value, detail });

async function isCheckedIn(stream) {
  const feed = await call(`/api/streams/${stream}/live`, { headers: mod });
  return feed.isCheckedIn;
}

async function rowsWritten() {
  const snap = await call('/api/quota', { headers: mod });
  if (snap.source !== 'local') {
    throw new Error(
      'quota is reporting Cloudflare account totals, which cannot see local ' +
        'writes — remove CF_API_TOKEN/CF_ACCOUNT_ID from .dev.vars for this run',
    );
  }
  return snap.metrics.find((m) => m.key === 'doRowsWritten')?.used ?? 0;
}

const results = [];
function check(label, ok) {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}

async function main() {
  // 1. stream_end releases the check-in once the grace period elapses.
  const a = 'autocheckout_a';
  await checkIn(a, 'test-client-aaaa');
  check('checked in', (await isCheckedIn(a)) === true);
  await streamEnd(a);
  check('still checked in during grace', (await isCheckedIn(a)) === true);
  await sleep(GRACE_MS + 2_000);
  check('checked out after grace', (await isCheckedIn(a)) === false);

  // 2. A broadcaster returning inside the grace period keeps the check-in.
  const b = 'autocheckout_b';
  await checkIn(b, 'test-client-bbbb');
  await streamEnd(b);
  await sleep(500);
  await status(b, 'live');
  await sleep(GRACE_MS + 2_000);
  check('restart inside grace keeps check-in', (await isCheckedIn(b)) === true);

  // 3. Repeated identical status posts should not write rows.
  const before = await rowsWritten();
  for (let i = 0; i < 20; i += 1) await status(b, 'offline', 'user_not_live');
  const firstBatch = (await rowsWritten()) - before;
  const mid = await rowsWritten();
  for (let i = 0; i < 20; i += 1) await status(b, 'offline', 'user_not_live');
  const secondBatch = (await rowsWritten()) - mid;
  console.log(
    `  20 offline posts wrote ${firstBatch} rows, next 20 wrote ${secondBatch}`,
  );
  check('repeat status posts stop writing', secondBatch === 0);

  // 4. A genuine status change still writes.
  const beforeChange = await rowsWritten();
  await status(b, 'live');
  check('status change still writes', (await rowsWritten()) > beforeChange);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
