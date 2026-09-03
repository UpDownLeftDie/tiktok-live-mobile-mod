import type {
  CheckedInStream,
  GiftCatalogItem,
  PushNotificationPayload,
} from '@tiktok-mod/shared';
import { dedupeGiftCatalogByName, GIFT_CATALOG } from '@tiktok-mod/shared';
import type { Env } from './env';
import { sendWebPush, type StoredSubscription } from './push';

/**
 * App-wide Durable Object: checked-in set, known streams list, push subscriptions.
 */
export class Registry implements DurableObject {
  private readonly env: Env;
  private migrated = false;

  constructor(
    private readonly ctx: DurableObjectState,
    env: Env,
  ) {
    this.env = env;
  }

  private async ensureMigrated(): Promise<void> {
    if (this.migrated) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      this.migrated = true;
    });
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS checked_in (
        stream_id TEXT PRIMARY KEY,
        checked_in_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS streams (
        stream_id TEXT PRIMARY KEY,
        added_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gift_catalog (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        gifts_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureMigrated();
    const path = new URL(request.url).pathname;
    const routeKey = `${request.method} ${path}`;

    switch (routeKey) {
      case 'GET /list':
        return this.listCheckedIn();
      case 'POST /check-in':
        return this.checkIn(request);
      case 'POST /check-out':
        return this.checkOut(request);
      case 'GET /streams':
        return this.listStreams();
      case 'POST /streams':
        return this.addStream(request);
      case 'POST /subscribe':
        return this.subscribe(request);
      case 'GET /subscriptions':
        return Response.json({ subscriptions: this.listSubscriptions() });
      case 'POST /push':
        return this.push(request);
      case 'POST /test-push':
        return this.testPush();
      case 'GET /gift-catalog':
        return this.getGiftCatalog();
      case 'PUT /gift-catalog':
        return this.putGiftCatalog(request);
      default:
        break;
    }

    if (request.method === 'DELETE' && path.startsWith('/streams/')) {
      return this.removeStream(path);
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  private listCheckedIn(): Response {
    const rows = this.ctx.storage.sql
      .exec<{
        stream_id: string;
        checked_in_at: number;
      }>(
        'SELECT stream_id, checked_in_at FROM checked_in ORDER BY checked_in_at ASC',
      )
      .toArray();
    const streams: CheckedInStream[] = rows.map((r) => ({
      streamId: r.stream_id,
      checkedInAt: r.checked_in_at,
    }));
    return Response.json({ streams });
  }

  private async checkIn(request: Request): Promise<Response> {
    const body = (await request.json()) as { streamId: string };
    if (!body.streamId) {
      return Response.json({ error: 'streamId required' }, { status: 400 });
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO checked_in (stream_id, checked_in_at) VALUES (?, ?)
       ON CONFLICT(stream_id) DO UPDATE SET checked_in_at = excluded.checked_in_at`,
      body.streamId,
      Date.now(),
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO streams (stream_id, added_at) VALUES (?, ?)
       ON CONFLICT(stream_id) DO NOTHING`,
      body.streamId,
      Date.now(),
    );
    return Response.json({ ok: true });
  }

  private async checkOut(request: Request): Promise<Response> {
    const body = (await request.json()) as { streamId: string };
    if (!body.streamId) {
      return Response.json({ error: 'streamId required' }, { status: 400 });
    }
    this.ctx.storage.sql.exec(
      'DELETE FROM checked_in WHERE stream_id = ?',
      body.streamId,
    );
    return Response.json({ ok: true });
  }

  private listStreams(): Response {
    const rows = this.ctx.storage.sql
      .exec<{
        stream_id: string;
        added_at: number;
      }>('SELECT stream_id, added_at FROM streams ORDER BY added_at ASC')
      .toArray();
    const checked = new Set(
      this.ctx.storage.sql
        .exec<{ stream_id: string }>('SELECT stream_id FROM checked_in')
        .toArray()
        .map((r) => r.stream_id),
    );
    return Response.json({
      streams: rows.map((r) => ({
        streamId: r.stream_id,
        addedAt: r.added_at,
        isCheckedIn: checked.has(r.stream_id),
      })),
    });
  }

  private async addStream(request: Request): Promise<Response> {
    const body = (await request.json()) as { streamId: string };
    const streamId = body.streamId?.trim().replace(/^@/, '');
    if (!streamId) {
      return Response.json({ error: 'streamId required' }, { status: 400 });
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO streams (stream_id, added_at) VALUES (?, ?)
       ON CONFLICT(stream_id) DO NOTHING`,
      streamId,
      Date.now(),
    );
    return Response.json({ ok: true, streamId });
  }

  private removeStream(path: string): Response {
    const streamId = decodeURIComponent(path.slice('/streams/'.length));
    this.ctx.storage.sql.exec(
      'DELETE FROM streams WHERE stream_id = ?',
      streamId,
    );
    this.ctx.storage.sql.exec(
      'DELETE FROM checked_in WHERE stream_id = ?',
      streamId,
    );
    return Response.json({ ok: true });
  }

  private async subscribe(request: Request): Promise<Response> {
    const sub = (await request.json()) as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };
    if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      return Response.json({ error: 'invalid subscription' }, { status: 400 });
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
      sub.endpoint,
      sub.keys.p256dh,
      sub.keys.auth,
      Date.now(),
    );
    return Response.json({ ok: true });
  }

  private async push(request: Request): Promise<Response> {
    const payload = (await request.json()) as PushNotificationPayload;
    const results = await this.broadcast(payload);
    return Response.json({ ok: true, results });
  }

  private async testPush(): Promise<Response> {
    const results = await this.broadcast({
      title: 'Test push',
      body: 'If you see this, Web Push is working.',
      tag: `test-${Date.now()}`,
      streamId: '',
      queueItemId: '',
      actions: [{ action: 'done', title: 'Done' }],
    });
    return Response.json({ ok: true, results });
  }

  private getGiftCatalog(): Response {
    const row = this.ctx.storage.sql
      .exec<{ gifts_json: string; updated_at: number }>(
        'SELECT gifts_json, updated_at FROM gift_catalog WHERE id = 1',
      )
      .toArray()[0];
    if (!row) {
      return Response.json({
        gifts: GIFT_CATALOG,
        updatedAt: null,
        source: 'bundled',
      });
    }
    try {
      const gifts = JSON.parse(row.gifts_json) as GiftCatalogItem[];
      if (!Array.isArray(gifts) || gifts.length === 0) {
        return Response.json({
          gifts: GIFT_CATALOG,
          updatedAt: null,
          source: 'bundled',
        });
      }
      return Response.json({
        gifts: dedupeGiftCatalogByName(gifts),
        updatedAt: row.updated_at,
        source: 'synced',
      });
    } catch {
      return Response.json({
        gifts: GIFT_CATALOG,
        updatedAt: null,
        source: 'bundled',
      });
    }
  }

  private async putGiftCatalog(request: Request): Promise<Response> {
    const body = (await request.json()) as { gifts?: GiftCatalogItem[] };
    const gifts = dedupeGiftCatalogByName(
      Array.isArray(body.gifts) ? body.gifts : [],
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO gift_catalog (id, gifts_json, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET gifts_json = excluded.gifts_json,
         updated_at = excluded.updated_at`,
      JSON.stringify(gifts),
      Date.now(),
    );
    return Response.json({ ok: true, count: gifts.length });
  }

  private listSubscriptions(): StoredSubscription[] {
    return this.ctx.storage.sql
      .exec<{
        endpoint: string;
        p256dh: string;
        auth: string;
      }>('SELECT endpoint, p256dh, auth FROM push_subscriptions')
      .toArray();
  }

  private async broadcast(
    payload: PushNotificationPayload,
  ): Promise<Array<{ endpoint: string; status: number }>> {
    const results: Array<{ endpoint: string; status: number }> = [];
    for (const sub of this.listSubscriptions()) {
      const result = await sendWebPush(this.env, sub, payload);
      results.push({ endpoint: sub.endpoint, status: result.status });
      if (result.status === 404 || result.status === 410) {
        this.ctx.storage.sql.exec(
          'DELETE FROM push_subscriptions WHERE endpoint = ?',
          sub.endpoint,
        );
      }
    }
    return results;
  }
}
