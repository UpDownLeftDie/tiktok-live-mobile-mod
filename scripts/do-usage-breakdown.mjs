// Attributes Durable Objects row usage by namespace and hour, so a spike can be
// traced to a specific object rather than guessed at.
//
// Usage: node scripts/do-usage-breakdown.mjs [hoursBack]
//
// Reads CF_ACCOUNT_ID / CF_API_TOKEN from apps/worker/.dev.vars. The token needs
// Account Analytics:Read. Note these figures are account-wide: other Workers
// projects on the same account show up here too.

import { readFileSync } from 'node:fs';

const HOURS_BACK = Number(process.argv[2] ?? '12');
// 'hour' for a broad view, 'minute' to see a deploy take effect.
const GRAIN = process.argv[3] === 'minute' ? 'datetimeMinute' : 'datetimeHour';
const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

const devVars = Object.fromEntries(
  readFileSync(new URL('../apps/worker/.dev.vars', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
);

async function gql(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${devVars.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join('; '));
  }
  return json.data?.viewer?.accounts?.[0] ?? {};
}

const num = (n) => (n ?? 0).toLocaleString();

async function main() {
  const end = new Date();
  const start = new Date(end.getTime() - HOURS_BACK * 3_600_000);
  const iso = (d) => `${d.toISOString().slice(0, 19)}Z`;

  const account = await gql(
    `query Usage($accountTag: string!, $start: Time!, $end: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          durableObjectsPeriodicGroups(
            filter: { ${GRAIN}_geq: $start, ${GRAIN}_lt: $end }
            limit: 10000
            orderBy: [${GRAIN}_ASC]
          ) {
            dimensions { ${GRAIN} namespaceId name }
            sum { rowsRead rowsWritten }
          }
        }
      }
    }`,
    {
      accountTag: devVars.CF_ACCOUNT_ID,
      start: iso(start),
      end: iso(new Date(end.getTime() + 3_600_000)),
    },
  );

  const rows = account.durableObjectsPeriodicGroups ?? [];
  if (rows.length === 0) {
    console.log('no data returned for that window');
    return;
  }

  const byScript = new Map();
  const byHour = new Map();
  for (const r of rows) {
    const script = r.dimensions.name || r.dimensions.namespaceId;
    const hour = r.dimensions[GRAIN];
    const read = r.sum.rowsRead ?? 0;
    const written = r.sum.rowsWritten ?? 0;
    const reqs = 0;

    const s = byScript.get(script) ?? { read: 0, written: 0, reqs: 0 };
    byScript.set(script, {
      read: s.read + read,
      written: s.written + written,
      reqs: s.reqs + reqs,
    });

    const h = byHour.get(hour) ?? new Map();
    const hs = h.get(script) ?? { read: 0, written: 0, reqs: 0 };
    h.set(script, {
      read: hs.read + read,
      written: hs.written + written,
      reqs: hs.reqs + reqs,
    });
    byHour.set(hour, h);
  }

  console.log(`\n=== rows read by script (last ${HOURS_BACK}h, account-wide) ===`);
  for (const [script, s] of [...byScript].sort((a, b) => b[1].read - a[1].read)) {
    console.log(
      `${script.padEnd(28)} read ${num(s.read).padStart(12)}   ` +
        `written ${num(s.written).padStart(10)}   reqs ${num(s.reqs).padStart(9)}`,
    );
  }

  console.log(`\n=== rows read per hour (UTC) ===`);
  for (const [hour, scripts] of [...byHour].sort()) {
    const total = [...scripts.values()].reduce((a, s) => a + s.read, 0);
    const detail = [...scripts]
      .sort((a, b) => b[1].read - a[1].read)
      .map(([s, v]) => `${s}=${num(v.read)}`)
      .join('  ');
    console.log(`${hour}  ${num(total).padStart(12)}   ${detail}`);
  }
}

await main();
