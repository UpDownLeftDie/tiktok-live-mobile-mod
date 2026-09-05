import type {
  ChatHighlightConfig,
  CheckedInStream,
  GiftAlertRule,
  GiftCatalogItem,
  GlobalSettings,
  PushNotificationPayload,
} from '@tiktok-mod/shared';
import {
  DEFAULT_CHAT_HIGHLIGHTS,
  DEFAULT_CHAT_KEYWORDS,
  DEFAULT_GIFT_ALERT_RULES,
  DEFAULT_GLOBAL_SETTINGS,
  dedupeGiftCatalogByName,
  GIFT_CATALOG,
  parseNameDisplayMode,
} from '@tiktok-mod/shared';
import { parseClientId } from './auth';
import type { Env } from './env';
import { TrackedSql } from './quota';
import { sendWebPush, type StoredSubscription } from './push';

/** Ephemeral watchers expire if the PWA stops heartbeating. Sticky check-ins do not. */
const PRESENCE_TTL_MS = 45_000;
/** Don't rewrite last_seen on every 10s poll — a read is cheaper than a write. */
const PRESENCE_TOUCH_MIN_MS = 12_000;
/** Sticky rows don't TTL-expire; only touch them for idle-checkout accounting. */
const STICKY_TOUCH_MIN_MS = 5 * 60_000;
const IDLE_CHECKOUT_MS = 60 * 60_000;
const SUBSCRIPTION_CACHE_MS = 60_000;
const MIGRATED_CLIENT_ID = 'migrated';

/**
 * App-wide Durable Object: checked-in set, known streams list, push subscriptions,
 * gift catalog, and global alert defaults.
 */
export class Registry implements DurableObject {
  private readonly env: Env;
  private readonly tracked: TrackedSql;
  private migrated = false;
  private subscriptionCache: { hasAny: boolean; at: number } | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    env: Env,
  ) {
    this.env = env;
    this.tracked = new TrackedSql(ctx);
  }

  private async ensureMigrated(): Promise<void> {
    if (this.migrated) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      this.migrated = true;
    });
  }

  private migrate(): void {
    this.tracked.exec(`
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
        created_at INTEGER NOT NULL,
        client_id TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS gift_catalog (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        gifts_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS global_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        gift_alert_rules TEXT NOT NULL,
        chat_keyword_flags TEXT NOT NULL,
        chat_highlights TEXT NOT NULL,
        name_display_mode TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS check_in_watchers (
        stream_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        sticky INTEGER NOT NULL DEFAULT 1,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (stream_id, client_id)
      );
    `);
    this.ensureColumn(
      'push_subscriptions',
      'client_id',
      "TEXT NOT NULL DEFAULT ''",
    );
    this.ensureGlobalSettingsRow();
    this.migrateCheckedInToWatchers();
  }

  private ensureColumn(table: string, column: string, typeSql: string): void {
    try {
      this.tracked.exec(
        `ALTER TABLE ${table} ADD COLUMN ${column} ${typeSql}`,
      );
    } catch {
      // column already exists
    }
  }

  /** Existing stream-level check-ins become a sticky placeholder until a real device claims them. */
  private migrateCheckedInToWatchers(): void {
    this.tracked.exec(
      `INSERT OR IGNORE INTO check_in_watchers (stream_id, client_id, sticky, last_seen_at)
       SELECT stream_id, ?, 1, checked_in_at FROM checked_in`,
      MIGRATED_CLIENT_ID,
    );
  }

  private ensureGlobalSettingsRow(): void {
    const existing = this.tracked
      .exec<{ id: number }>('SELECT id FROM global_settings WHERE id = 1')
      .toArray();
    if (existing.length > 0) return;
    this.tracked.exec(
      `INSERT INTO global_settings (
         id, gift_alert_rules, chat_keyword_flags, chat_highlights, name_display_mode
       ) VALUES (1, ?, ?, ?, ?)`,
      JSON.stringify(DEFAULT_GIFT_ALERT_RULES),
      JSON.stringify(DEFAULT_CHAT_KEYWORDS),
      JSON.stringify(DEFAULT_CHAT_HIGHLIGHTS),
      DEFAULT_GLOBAL_SETTINGS.nameDisplayMode,
    );
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureMigrated();
    try {
      const path = new URL(request.url).pathname;
      const routeKey = `${request.method} ${path}`;

      switch (routeKey) {
        case 'GET /quota':
          return Response.json(this.tracked.snapshot());
        case 'GET /stream-ids':
          return this.listStreamIds();
        case 'GET /list':
          return this.listCheckedIn();
      case 'POST /check-in':
        return this.checkIn(request);
      case 'POST /check-out':
        return this.checkOut(request);
      case 'POST /presence':
        return this.touchPresence(request);
      case 'GET /streams':
        return this.listStreams(request);
      case 'POST /streams':
        return this.addStream(request);
      case 'POST /subscribe':
        return this.subscribe(request);
      case 'GET /subscriptions':
        return Response.json({ subscriptions: this.listSubscriptions() });
      case 'POST /push':
        return this.push(request);
      case 'POST /test-push':
        return this.testPush(request);
      case 'GET /gift-catalog':
        return this.getGiftCatalog();
      case 'PUT /gift-catalog':
        return this.putGiftCatalog(request);
      case 'GET /global-settings':
        return Response.json(this.getGlobalSettings());
      case 'PUT /global-settings':
        return this.putGlobalSettings(request);
      default:
        break;
    }

    if (request.method === 'DELETE' && path.startsWith('/streams/')) {
      return this.removeStream(path);
    }
    return Response.json({ error: 'not found' }, { status: 404 });
    } finally {
      this.ctx.waitUntil(
        Promise.resolve().then(() => this.tracked.flush()),
      );
    }
  }

  private getGlobalSettings(): GlobalSettings {
    this.ensureGlobalSettingsRow();
    const row = this.tracked
      .exec<{
        gift_alert_rules: string;
        chat_keyword_flags: string;
        chat_highlights: string;
        name_display_mode: string;
      }>('SELECT * FROM global_settings WHERE id = 1')
      .one();

    let giftAlertRules: GiftAlertRule[];
    let chatKeywordFlags: string[];
    let chatHighlights: ChatHighlightConfig;
    try {
      giftAlertRules = JSON.parse(row.gift_alert_rules) as GiftAlertRule[];
    } catch {
      giftAlertRules = DEFAULT_GIFT_ALERT_RULES;
    }
    try {
      chatKeywordFlags = JSON.parse(row.chat_keyword_flags) as string[];
    } catch {
      chatKeywordFlags = DEFAULT_CHAT_KEYWORDS;
    }
    try {
      chatHighlights = {
        ...DEFAULT_CHAT_HIGHLIGHTS,
        ...(JSON.parse(row.chat_highlights) as ChatHighlightConfig),
      };
    } catch {
      chatHighlights = { ...DEFAULT_CHAT_HIGHLIGHTS };
    }

    return {
      giftAlertRules: Array.isArray(giftAlertRules)
        ? giftAlertRules
        : DEFAULT_GIFT_ALERT_RULES,
      chatKeywordFlags: Array.isArray(chatKeywordFlags)
        ? chatKeywordFlags
        : DEFAULT_CHAT_KEYWORDS,
      chatHighlights,
      nameDisplayMode: parseNameDisplayMode(row.name_display_mode),
    };
  }

  private async putGlobalSettings(request: Request): Promise<Response> {
    this.ensureGlobalSettingsRow();
    const body = (await request.json()) as Partial<GlobalSettings>;
    const current = this.getGlobalSettings();

    const giftAlertRules = Array.isArray(body.giftAlertRules)
      ? body.giftAlertRules
      : current.giftAlertRules;
    const chatKeywordFlags = Array.isArray(body.chatKeywordFlags)
      ? body.chatKeywordFlags
      : current.chatKeywordFlags;
    const chatHighlights = body.chatHighlights
      ? {
          ...DEFAULT_CHAT_HIGHLIGHTS,
          ...body.chatHighlights,
          highlightUsernames: (body.chatHighlights.highlightUsernames ?? [])
            .map((u) => u.trim().replace(/^@/, ''))
            .filter(Boolean),
        }
      : current.chatHighlights;
    const nameDisplayMode =
      body.nameDisplayMode != null
        ? parseNameDisplayMode(body.nameDisplayMode)
        : current.nameDisplayMode;

    this.tracked.exec(
      `UPDATE global_settings SET
         gift_alert_rules = ?,
         chat_keyword_flags = ?,
         chat_highlights = ?,
         name_display_mode = ?
       WHERE id = 1`,
      JSON.stringify(giftAlertRules),
      JSON.stringify(chatKeywordFlags),
      JSON.stringify(chatHighlights),
      nameDisplayMode,
    );

    return Response.json(this.getGlobalSettings());
  }

  private listStreamIds(): Response {
    const rows = this.tracked
      .exec<{ stream_id: string }>('SELECT stream_id FROM streams')
      .toArray();
    return Response.json({
      streamIds: rows.map((r) => r.stream_id),
    });
  }

  private async listCheckedIn(): Promise<Response> {
    const before = this.activeStreamIdSet();
    this.pruneExpiredWatchers();
    this.pruneUnreachableCheckIns();
    const after = this.activeStreamIdSet();
    this.ctx.waitUntil(this.syncStreamSessions(before, after));

    const streams: CheckedInStream[] = [...after]
      .sort()
      .map((streamId) => ({
        streamId,
        checkedInAt: this.earliestWatcherSeen(streamId),
      }));
    return Response.json({ streams });
  }

  private async checkIn(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      streamId?: string;
      clientId?: unknown;
    };
    if (!body.streamId) {
      return Response.json({ error: 'streamId required' }, { status: 400 });
    }
    const clientId = parseClientId(body.clientId);
    if (!clientId) {
      return Response.json({ error: 'clientId required' }, { status: 400 });
    }
    this.upsertWatcher(body.streamId, clientId, true);
    this.tracked.exec(
      `INSERT INTO streams (stream_id, added_at) VALUES (?, ?)
       ON CONFLICT(stream_id) DO NOTHING`,
      body.streamId,
      Date.now(),
    );
    this.syncCheckedInRow(body.streamId);
    return Response.json(this.watcherStatus(body.streamId, clientId));
  }

  private async checkOut(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      streamId?: string;
      clientId?: unknown;
      force?: unknown;
    };
    if (!body.streamId) {
      return Response.json({ error: 'streamId required' }, { status: 400 });
    }
    const clientId = parseClientId(body.clientId);
    if (!clientId) {
      return Response.json({ error: 'clientId required' }, { status: 400 });
    }
    if (body.force === true) {
      this.tracked.exec(
        'DELETE FROM check_in_watchers WHERE stream_id = ?',
        body.streamId,
      );
    } else {
      this.tracked.exec(
        'DELETE FROM check_in_watchers WHERE stream_id = ? AND client_id = ?',
        body.streamId,
        clientId,
      );
    }
    this.pruneExpiredWatchers();
    this.syncCheckedInRow(body.streamId);
    return Response.json(this.watcherStatus(body.streamId, clientId));
  }

  private async touchPresence(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      clientId?: unknown;
      streamIds?: unknown;
    };
    const clientId = parseClientId(body.clientId);
    if (!clientId) {
      return Response.json({ error: 'clientId required' }, { status: 400 });
    }
    const streamIds = Array.isArray(body.streamIds)
      ? body.streamIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];

    const before = this.activeStreamIdSet();
    this.pruneExpiredWatchers();

    if (streamIds.length === 0) {
      this.tracked.exec(
        'DELETE FROM check_in_watchers WHERE client_id = ? AND sticky = 0',
        clientId,
      );
    } else {
      this.tracked.exec(
        `DELETE FROM check_in_watchers
         WHERE client_id = ? AND sticky = 0 AND stream_id NOT IN (${streamIds
           .map(() => '?')
           .join(', ')})`,
        clientId,
        ...streamIds,
      );
    }

    for (const streamId of streamIds) {
      if (this.watcherCount(streamId) === 0) continue;
      this.upsertWatcher(streamId, clientId, false, {
        touchMinMs: PRESENCE_TOUCH_MIN_MS,
      });
    }

    this.pruneExpiredWatchers();
    const after = this.activeStreamIdSet();
    this.ctx.waitUntil(this.syncStreamSessions(before, after));
    for (const streamId of new Set([...before, ...after, ...streamIds])) {
      this.syncCheckedInRow(streamId);
    }

    return Response.json({ ok: true, streams: [...after] });
  }

  private async listStreams(request: Request): Promise<Response> {
    const before = this.activeStreamIdSet();
    this.pruneExpiredWatchers();
    const after = this.activeStreamIdSet();
    this.ctx.waitUntil(this.syncStreamSessions(before, after));
    for (const streamId of new Set([...before, ...after])) {
      this.syncCheckedInRow(streamId);
    }

    const clientId = parseClientId(new URL(request.url).searchParams.get('clientId'));
    const rows = this.tracked
      .exec<{
        stream_id: string;
        added_at: number;
      }>('SELECT stream_id, added_at FROM streams ORDER BY added_at ASC')
      .toArray();
    const watchers = this.watchersByStream();
    return Response.json({
      streams: rows.map((r) => {
        const set = watchers.get(r.stream_id);
        return {
          streamId: r.stream_id,
          addedAt: r.added_at,
          isCheckedIn: Boolean(set && set.size > 0),
          watcherCount: set?.size ?? 0,
          youAreWatching: Boolean(clientId && set?.has(clientId)),
        };
      }),
    });
  }

  private async addStream(request: Request): Promise<Response> {
    const body = (await request.json()) as { streamId: string };
    const streamId = body.streamId?.trim().replace(/^@/, '');
    if (!streamId) {
      return Response.json({ error: 'streamId required' }, { status: 400 });
    }
    this.tracked.exec(
      `INSERT INTO streams (stream_id, added_at) VALUES (?, ?)
       ON CONFLICT(stream_id) DO NOTHING`,
      streamId,
      Date.now(),
    );
    return Response.json({ ok: true, streamId });
  }

  private async removeStream(path: string): Promise<Response> {
    const streamId = decodeURIComponent(path.slice('/streams/'.length));
    const wasActive = this.activeStreamIdSet().has(streamId);
    this.tracked.exec(
      'DELETE FROM streams WHERE stream_id = ?',
      streamId,
    );
    this.tracked.exec(
      'DELETE FROM checked_in WHERE stream_id = ?',
      streamId,
    );
    this.tracked.exec(
      'DELETE FROM check_in_watchers WHERE stream_id = ?',
      streamId,
    );
    if (wasActive) {
      this.ctx.waitUntil(this.notifyStreamCheckedIn(streamId, false));
    }
    return Response.json({ ok: true });
  }

  private pruneExpiredWatchers(): void {
    this.tracked.exec(
      'DELETE FROM check_in_watchers WHERE sticky = 0 AND last_seen_at < ?',
      Date.now() - PRESENCE_TTL_MS,
    );
  }

  /**
   * With no push subscription to alert and no browser open anywhere, a check-in
   * cannot reach anyone — the relay would just burn rows into a feed nobody
   * reads. Presence on any one stream counts, since watching a single feed
   * still means the app is open.
   */
  private pruneUnreachableCheckIns(): void {
    if (this.hasPushSubscriptions()) return;
    const seen = this.tracked
      .exec<{ t: number | null }>(
        'SELECT MAX(last_seen_at) AS t FROM check_in_watchers',
      )
      .one().t;
    if (seen == null || Date.now() - seen < IDLE_CHECKOUT_MS) return;
    this.tracked.exec('DELETE FROM check_in_watchers');
  }

  private hasPushSubscriptions(): boolean {
    const now = Date.now();
    if (
      this.subscriptionCache &&
      now - this.subscriptionCache.at < SUBSCRIPTION_CACHE_MS
    ) {
      return this.subscriptionCache.hasAny;
    }
    const hasAny =
      this.tracked
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM push_subscriptions')
        .one().n > 0;
    this.subscriptionCache = { hasAny, at: now };
    return hasAny;
  }

  /** First real device to touch a pre-migration check-in inherits the sticky slot. */
  private takeMigratedSticky(streamId: string): boolean {
    const row = this.tracked
      .exec<{ n: number }>(
        'SELECT COUNT(*) AS n FROM check_in_watchers WHERE stream_id = ? AND client_id = ?',
        streamId,
        MIGRATED_CLIENT_ID,
      )
      .one();
    if (row.n === 0) return false;
    this.tracked.exec(
      'DELETE FROM check_in_watchers WHERE stream_id = ? AND client_id = ?',
      streamId,
      MIGRATED_CLIENT_ID,
    );
    return true;
  }

  private upsertWatcher(
    streamId: string,
    clientId: string,
    sticky: boolean,
    opts?: { touchMinMs?: number },
  ): void {
    const inherited = this.takeMigratedSticky(streamId);
    const makeSticky = sticky || inherited ? 1 : 0;
    const now = Date.now();

    if (opts?.touchMinMs != null) {
      const existing = this.tracked
        .exec<{ last_seen_at: number; sticky: number }>(
          `SELECT last_seen_at, sticky FROM check_in_watchers
           WHERE stream_id = ? AND client_id = ?`,
          streamId,
          clientId,
        )
        .toArray()[0];
      if (existing) {
        const minMs =
          existing.sticky > 0 ? STICKY_TOUCH_MIN_MS : opts.touchMinMs;
        const stickyUpgrade = makeSticky > existing.sticky;
        if (!stickyUpgrade && now - existing.last_seen_at < minMs) {
          return;
        }
      }
    }

    this.tracked.exec(
      `INSERT INTO check_in_watchers (stream_id, client_id, sticky, last_seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(stream_id, client_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         sticky = CASE
           WHEN check_in_watchers.sticky > excluded.sticky
           THEN check_in_watchers.sticky
           ELSE excluded.sticky
         END`,
      streamId,
      clientId,
      makeSticky,
      now,
    );
  }

  private watcherCount(streamId: string): number {
    return this.tracked
      .exec<{ n: number }>(
        'SELECT COUNT(*) AS n FROM check_in_watchers WHERE stream_id = ?',
        streamId,
      )
      .one().n;
  }

  private watcherStatus(
    streamId: string,
    clientId: string,
  ): {
    ok: true;
    streamId: string;
    isCheckedIn: boolean;
    watcherCount: number;
    youAreWatching: boolean;
  } {
    const count = this.watcherCount(streamId);
    const you = this.tracked
      .exec<{ n: number }>(
        'SELECT COUNT(*) AS n FROM check_in_watchers WHERE stream_id = ? AND client_id = ?',
        streamId,
        clientId,
      )
      .one().n;
    return {
      ok: true,
      streamId,
      isCheckedIn: count > 0,
      watcherCount: count,
      youAreWatching: you > 0,
    };
  }

  private activeStreamIdSet(): Set<string> {
    return new Set(
      this.tracked
        .exec<{ stream_id: string }>(
          'SELECT DISTINCT stream_id FROM check_in_watchers',
        )
        .toArray()
        .map((r) => r.stream_id),
    );
  }

  private earliestWatcherSeen(streamId: string): number {
    const row = this.tracked
      .exec<{ t: number | null }>(
        'SELECT MIN(last_seen_at) AS t FROM check_in_watchers WHERE stream_id = ?',
        streamId,
      )
      .one();
    return row.t ?? Date.now();
  }

  private watchersByStream(): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    const rows = this.tracked
      .exec<{ stream_id: string; client_id: string }>(
        'SELECT stream_id, client_id FROM check_in_watchers',
      )
      .toArray();
    for (const row of rows) {
      let set = map.get(row.stream_id);
      if (!set) {
        set = new Set();
        map.set(row.stream_id, set);
      }
      set.add(row.client_id);
    }
    return map;
  }

  private syncCheckedInRow(streamId: string): void {
    const count = this.watcherCount(streamId);
    if (count === 0) {
      this.tracked.exec(
        'DELETE FROM checked_in WHERE stream_id = ?',
        streamId,
      );
      return;
    }
    this.tracked.exec(
      `INSERT INTO checked_in (stream_id, checked_in_at) VALUES (?, ?)
       ON CONFLICT(stream_id) DO NOTHING`,
      streamId,
      Date.now(),
    );
  }

  private async syncStreamSessions(
    before: Set<string>,
    after: Set<string>,
  ): Promise<void> {
    for (const streamId of after) {
      if (!before.has(streamId)) {
        await this.notifyStreamCheckedIn(streamId, true);
      }
    }
    for (const streamId of before) {
      if (!after.has(streamId)) {
        await this.notifyStreamCheckedIn(streamId, false);
      }
    }
  }

  private async notifyStreamCheckedIn(
    streamId: string,
    isCheckedIn: boolean,
  ): Promise<void> {
    try {
      const id = this.env.STREAM_SESSION.idFromName(streamId);
      await this.env.STREAM_SESSION.get(id).fetch(
        new Request(
          `https://do/sync-check?streamId=${encodeURIComponent(streamId)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isCheckedIn }),
          },
        ),
      );
    } catch (err) {
      console.error('notifyStreamCheckedIn failed', streamId, err);
    }
  }

  private async subscribe(request: Request): Promise<Response> {
    const sub = (await request.json()) as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
      clientId?: unknown;
    };
    const clientId = parseClientId(sub.clientId);
    if (!clientId) {
      return Response.json({ error: 'clientId required' }, { status: 400 });
    }
    if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      return Response.json({ error: 'invalid subscription' }, { status: 400 });
    }
    this.tracked.exec(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, client_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         client_id = excluded.client_id`,
      sub.endpoint,
      sub.keys.p256dh,
      sub.keys.auth,
      Date.now(),
      clientId,
    );
    this.subscriptionCache = null;
    return Response.json({ ok: true });
  }

  private async push(request: Request): Promise<Response> {
    const payload = (await request.json()) as PushNotificationPayload;
    const results = await this.broadcast(payload);
    return Response.json({ ok: true, results });
  }

  private async testPush(request: Request): Promise<Response> {
    let body: { clientId?: unknown } = {};
    try {
      body = (await request.json()) as { clientId?: unknown };
    } catch {
      // empty body
    }
    const clientId = parseClientId(body.clientId);
    if (!clientId) {
      return Response.json({ error: 'clientId required' }, { status: 400 });
    }
    const results = await this.broadcast(
      {
        title: 'Test push',
        body: 'If you see this, Web Push is working.',
        tag: `test-${Date.now()}`,
        streamId: '',
        queueItemId: '',
        actions: [{ action: 'done', title: 'Done' }],
      },
      { clientId },
    );
    return Response.json({ ok: true, results });
  }

  private getGiftCatalog(): Response {
    const row = this.tracked
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
    this.tracked.exec(
      `INSERT INTO gift_catalog (id, gifts_json, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET gifts_json = excluded.gifts_json,
         updated_at = excluded.updated_at`,
      JSON.stringify(gifts),
      Date.now(),
    );
    return Response.json({ ok: true, count: gifts.length });
  }

  private listSubscriptions(): StoredSubscription[] {
    return this.tracked
      .exec<{
        endpoint: string;
        p256dh: string;
        auth: string;
      }>('SELECT endpoint, p256dh, auth FROM push_subscriptions')
      .toArray();
  }

  /** Sticky check-in watchers for a stream — checked-out devices are excluded. */
  private listSubscriptionsForStream(streamId: string): StoredSubscription[] {
    return this.tracked
      .exec<{
        endpoint: string;
        p256dh: string;
        auth: string;
      }>(
        `SELECT ps.endpoint, ps.p256dh, ps.auth
         FROM push_subscriptions ps
         INNER JOIN check_in_watchers w
           ON w.client_id = ps.client_id
         WHERE w.stream_id = ? AND w.sticky = 1`,
        streamId,
      )
      .toArray();
  }

  private listSubscriptionsForClient(clientId: string): StoredSubscription[] {
    return this.tracked
      .exec<{
        endpoint: string;
        p256dh: string;
        auth: string;
      }>(
        'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE client_id = ?',
        clientId,
      )
      .toArray();
  }

  private async broadcast(
    payload: PushNotificationPayload,
    opts?: { clientId?: string },
  ): Promise<Array<{ endpoint: string; status: number }>> {
    let subs: StoredSubscription[] = [];
    if (payload.streamId) {
      subs = this.listSubscriptionsForStream(payload.streamId);
    } else if (opts?.clientId) {
      subs = this.listSubscriptionsForClient(opts.clientId);
    }
    const results: Array<{ endpoint: string; status: number }> = [];
    for (const sub of subs) {
      const result = await sendWebPush(this.env, sub, payload);
      results.push({ endpoint: sub.endpoint, status: result.status });
      if (result.status === 404 || result.status === 410) {
        this.tracked.exec(
          'DELETE FROM push_subscriptions WHERE endpoint = ?',
          sub.endpoint,
        );
        this.subscriptionCache = null;
      }
    }
    return results;
  }
}
