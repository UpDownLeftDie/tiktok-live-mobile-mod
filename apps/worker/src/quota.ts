import { registryStub, streamStub } from './auth';
import type { Env } from './env';

export const FREE_TIER_LIMITS = {
  doRowsRead: 5_000_000,
  doRowsWritten: 100_000,
} as const;

export type QuotaMetric = {
  key: string;
  label: string;
  used: number;
  limit: number;
};

export type QuotaObject = {
  name: string;
  rowsRead: number;
  rowsWritten: number;
};

export type QuotaSnapshot = {
  source: 'cloudflare' | 'local';
  date: string;
  resetAt: string;
  metrics: QuotaMetric[];
  objects: QuotaObject[];
};

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const CACHE_TTL_SECONDS = 60;
const MAX_STREAMS = 50;

export function utcDateString(ms = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function nextUtcMidnightIso(ms = Date.now()): string {
  const d = new Date(ms);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1),
  ).toISOString();
}

function metric(
  key: string,
  label: string,
  used: number,
  limit: number,
): QuotaMetric {
  return { key, label, used, limit };
}

function snapshotFromCounts(
  source: QuotaSnapshot['source'],
  doRowsRead: number,
  doRowsWritten: number,
  objects: QuotaObject[],
): QuotaSnapshot {
  const metrics: QuotaMetric[] = [
    metric(
      'doRowsRead',
      'Durable Objects row reads',
      doRowsRead,
      FREE_TIER_LIMITS.doRowsRead,
    ),
    metric(
      'doRowsWritten',
      'Durable Objects row writes',
      doRowsWritten,
      FREE_TIER_LIMITS.doRowsWritten,
    ),
  ];
  return {
    source,
    date: utcDateString(),
    resetAt: nextUtcMidnightIso(),
    metrics,
    objects,
  };
}

type LocalCounts = { date: string; rowsRead: number; rowsWritten: number };

export class TrackedSql {
  private mem: LocalCounts | null = null;
  private lastFlushed: LocalCounts | null = null;

  constructor(private readonly ctx: DurableObjectState) {}

  exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): SqlStorageCursor<T> {
    const cursor = this.ctx.storage.sql.exec<T>(query, ...bindings);
    return trackCursor(cursor, (rowsRead, rowsWritten) => {
      this.add(rowsRead, rowsWritten);
    });
  }

  snapshot(): LocalCounts {
    this.load();
    this.flush();
    return { ...this.mem! };
  }

  flush(): void {
    this.load();
    const { date, rowsRead, rowsWritten } = this.mem!;
    const prev = this.lastFlushed;
    if (
      prev &&
      prev.date === date &&
      prev.rowsRead === rowsRead &&
      prev.rowsWritten === rowsWritten
    ) {
      return;
    }
    this.ctx.storage.kv.put(`quota:v1:${date}:r`, rowsRead);
    this.ctx.storage.kv.put(`quota:v1:${date}:w`, rowsWritten);
    this.lastFlushed = { date, rowsRead, rowsWritten };
  }

  private add(rowsRead: number, rowsWritten: number): void {
    this.load();
    this.mem!.rowsRead += rowsRead;
    this.mem!.rowsWritten += rowsWritten;
  }

  private load(): void {
    const date = utcDateString();
    if (this.mem?.date === date) return;
    this.mem = {
      date,
      rowsRead: Number(this.ctx.storage.kv.get<number>(`quota:v1:${date}:r`) ?? 0),
      rowsWritten: Number(
        this.ctx.storage.kv.get<number>(`quota:v1:${date}:w`) ?? 0,
      ),
    };
  }
}

function trackCursor<T extends Record<string, SqlStorageValue>>(
  cursor: SqlStorageCursor<T>,
  onDone: (rowsRead: number, rowsWritten: number) => void,
): SqlStorageCursor<T> {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    onDone(cursor.rowsRead, cursor.rowsWritten);
  };
  const wrapped = {
    get columnNames() {
      return cursor.columnNames;
    },
    get rowsRead() {
      return cursor.rowsRead;
    },
    get rowsWritten() {
      return cursor.rowsWritten;
    },
    toArray: () => {
      const rows = cursor.toArray();
      finish();
      return rows;
    },
    one: () => {
      const row = cursor.one();
      finish();
      return row;
    },
    raw: () => cursor.raw(),
    next: () => {
      const step = cursor.next();
      if (step.done) finish();
      return step;
    },
    [Symbol.iterator]() {
      return this;
    },
  };
  queueMicrotask(finish);
  return wrapped as SqlStorageCursor<T>;
}

async function fetchCloudflareSnapshot(env: Env): Promise<QuotaSnapshot> {
  const date = utcDateString();
  const query = `
    query Quota($accountTag: string!, $date: Date!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          durableObjectsPeriodicGroups(
            filter: { date: $date }
            limit: 1000
          ) {
            dimensions { name namespaceId }
            sum { rowsRead rowsWritten }
          }
        }
      }
    }
  `;
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: { accountTag: env.CF_ACCOUNT_ID, date },
    }),
  });
  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    data?: {
      viewer?: {
        accounts?: Array<{
          durableObjectsPeriodicGroups?: Array<{
            dimensions: { name: string | null };
            sum: { rowsRead: number | null; rowsWritten: number | null };
          }>;
        }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join('; '));
  }
  const account = json.data?.viewer?.accounts?.[0];
  if (!account) throw new Error('no analytics account');

  const objects: QuotaObject[] = [];
  let doRowsRead = 0;
  let doRowsWritten = 0;
  for (const row of account.durableObjectsPeriodicGroups ?? []) {
    const rowsRead = row.sum.rowsRead ?? 0;
    const rowsWritten = row.sum.rowsWritten ?? 0;
    doRowsRead += rowsRead;
    doRowsWritten += rowsWritten;
    objects.push({
      name: row.dimensions.name || 'unknown',
      rowsRead,
      rowsWritten,
    });
  }
  objects.sort((a, b) => b.rowsRead - a.rowsRead);

  return snapshotFromCounts(
    'cloudflare',
    doRowsRead,
    doRowsWritten,
    objects.slice(0, 8),
  );
}

async function fetchLocalSnapshot(env: Env): Promise<QuotaSnapshot> {
  const registryCounts = await readDoQuota(
    registryStub(env).fetch(new Request('https://registry/quota')),
  );
  const listRes = await registryStub(env).fetch(
    new Request('https://registry/stream-ids'),
  );
  const list = (await listRes.json()) as { streamIds?: string[] };
  const streamIds = (list.streamIds ?? [])
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .slice(0, MAX_STREAMS);

  const streamCounts = await Promise.all(
    streamIds.map(async (streamId) => {
      const counts = await readDoQuota(
        streamStub(env, streamId).fetch(
          new Request(
            `https://do/quota?streamId=${encodeURIComponent(streamId)}`,
          ),
        ),
      );
      return { name: streamId, ...counts };
    }),
  );

  const objects: QuotaObject[] = [
    {
      name: 'registry',
      rowsRead: registryCounts.rowsRead,
      rowsWritten: registryCounts.rowsWritten,
    },
    ...streamCounts,
  ].sort((a, b) => b.rowsRead - a.rowsRead);

  const doRowsRead = objects.reduce((sum, o) => sum + o.rowsRead, 0);
  const doRowsWritten = objects.reduce((sum, o) => sum + o.rowsWritten, 0);
  return snapshotFromCounts(
    'local',
    doRowsRead,
    doRowsWritten,
    objects.slice(0, 8),
  );
}

async function readDoQuota(
  pending: Promise<Response>,
): Promise<{ rowsRead: number; rowsWritten: number }> {
  try {
    const res = await pending;
    if (!res.ok) return { rowsRead: 0, rowsWritten: 0 };
    const body = (await res.json()) as {
      rowsRead?: number;
      rowsWritten?: number;
    };
    return {
      rowsRead: Number(body.rowsRead) || 0,
      rowsWritten: Number(body.rowsWritten) || 0,
    };
  } catch {
    return { rowsRead: 0, rowsWritten: 0 };
  }
}

export async function fetchQuotaSnapshot(env: Env): Promise<QuotaSnapshot> {
  const date = utcDateString();
  const cacheKey = new Request(`https://tiktok-live-mod.quota/${date}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    return cached.json() as Promise<QuotaSnapshot>;
  }

  let snapshot: QuotaSnapshot;
  if (env.CF_API_TOKEN && env.CF_ACCOUNT_ID) {
    try {
      snapshot = await fetchCloudflareSnapshot(env);
    } catch (err) {
      console.error('quota graphql failed', err);
      snapshot = await fetchLocalSnapshot(env);
    }
  } else {
    snapshot = await fetchLocalSnapshot(env);
  }

  await caches.default.put(
    cacheKey,
    Response.json(snapshot, {
      headers: { 'Cache-Control': `max-age=${CACHE_TTL_SECONDS}` },
    }),
  );
  return snapshot;
}
