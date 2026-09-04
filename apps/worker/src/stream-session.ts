import {
  DEFAULT_CHAT_HIGHLIGHTS,
  DEFAULT_GLOBAL_SETTINGS,
  formatGiftAlertBody,
  formatPersonLabel,
  giftDiamondSpend,
  isDefaultAlertSettings,
  resolveAlertSettings,
  type AlertSettingsOverrides,
  type ChatHighlightConfig,
  type ChatLogItem,
  type ChatUserSignals,
  type ConnectionStatus,
  type GiftAlertRule,
  type GiftLogItem,
  type GlobalSettings,
  type LiveFeed,
  type PushNotificationPayload,
  type QueueItem,
  type QueueItemPayload,
  type QueueItemStatus,
  type RelayChatEvent,
  type RelayDisconnectedEvent,
  type RelayEvent,
  type RelayGiftEvent,
  type RelayRoomEvent,
  type RelayStatusEvent,
  type RoomLogItem,
  type StreamConfig,
} from '@tiktok-mod/shared';
import { parseClientId } from './auth';
import type { Env } from './env';
import { TrackedSql } from './quota';

const CHAT_LIMIT = 200;
const EVENT_LIMIT = 200;
const GIFT_LIMIT = 200;
const GLOBAL_SETTINGS_TTL_MS = 10_000;
const SEQ_KEY = 'feed:seq';
const SEQ_BACKFILL_KEY = 'feed:seq:backfilled';
const FEED_TABLES = ['chat_log', 'room_events', 'gift_log'] as const;
type FeedTable = (typeof FEED_TABLES)[number];

/**
 * Trimming scans the tail of a log, so amortize it over several inserts
 * instead of paying that scan on every incoming event.
 */
const TRIM_EVERY = 25;

/**
 * Grace period after a broadcast ends before the check-in is released, so a
 * broadcaster who drops and restarts does not cost the mod their check-in.
 */
const AUTO_CHECKOUT_AFTER_STREAM_END_MS = 15 * 60_000;
const AUTO_CHECKOUT_CLIENT_ID = 'auto-checkout';

type ChatRow = {
  id: string;
  stream_id: string;
  username: string | null;
  comment: string;
  flagged_keyword: string | null;
  queue_item_id: string | null;
  user_signals: string | null;
  created_at: number;
};

type RoomRow = {
  id: string;
  stream_id: string;
  type: string;
  username: string | null;
  nickname: string | null;
  summary: string;
  created_at: number;
};

type GiftRow = {
  id: string;
  stream_id: string;
  sender_username: string | null;
  sender_nickname: string | null;
  gift_name: string | null;
  gift_count: number;
  diamond_value: number | null;
  target_username: string | null;
  target_nickname: string | null;
  alert_status: string;
  queue_item_id: string | null;
  matched_rule: string | null;
  created_at: number;
};

function uuid(): string {
  return crypto.randomUUID();
}

async function readWatcherBody(
  request: Request,
): Promise<{ clientId: string | null; force: boolean }> {
  try {
    const body = (await request.json()) as {
      clientId?: unknown;
      force?: unknown;
    };
    return {
      clientId: parseClientId(body.clientId),
      force: body.force === true,
    };
  } catch {
    return { clientId: null, force: false };
  }
}

export class StreamSession implements DurableObject {
  private readonly env: Env;
  private readonly tracked: TrackedSql;
  private migrated = false;
  private seq: number | null = null;
  private lastStatus: {
    status: ConnectionStatus;
    detail: string | null;
  } | null = null;
  private readonly insertsSinceTrim = new Map<FeedTable, number>();
  private globalSettingsCache: { value: GlobalSettings; fetchedAt: number } | null =
    null;

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
      CREATE TABLE IF NOT EXISTS queue_items (
        id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS gift_log (
        id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        sender_username TEXT,
        sender_nickname TEXT,
        gift_name TEXT,
        gift_count INTEGER,
        diamond_value INTEGER,
        target_username TEXT,
        target_nickname TEXT,
        alert_status TEXT NOT NULL DEFAULT 'none',
        queue_item_id TEXT,
        matched_rule TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_log (
        id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        username TEXT,
        comment TEXT NOT NULL,
        flagged_keyword TEXT,
        queue_item_id TEXT,
        is_new_chatter INTEGER NOT NULL DEFAULT 0,
        user_signals TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_events (
        id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        type TEXT NOT NULL,
        username TEXT,
        nickname TEXT,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stream_config (
        stream_id TEXT PRIMARY KEY,
        gift_alert_rules TEXT,
        chat_keyword_flags TEXT,
        chat_highlights TEXT,
        is_checked_in INTEGER NOT NULL DEFAULT 0,
        connection_status TEXT NOT NULL DEFAULT 'idle',
        connection_detail TEXT,
        status_updated_at INTEGER
      );
    `);
    this.ensureColumn('gift_log', 'diamond_value', 'INTEGER');
    this.ensureColumn(
      'gift_log',
      'alert_status',
      "TEXT NOT NULL DEFAULT 'none'",
    );
    this.ensureColumn('gift_log', 'queue_item_id', 'TEXT');
    this.ensureColumn('gift_log', 'matched_rule', 'TEXT');
    this.ensureColumn('gift_log', 'target_nickname', 'TEXT');
    this.ensureColumn('gift_log', 'sender_nickname', 'TEXT');
    this.ensureColumn(
      'chat_log',
      'is_new_chatter',
      'INTEGER NOT NULL DEFAULT 0',
    );
    this.ensureColumn('chat_log', 'user_signals', 'TEXT');
    this.ensureColumn(
      'stream_config',
      'connection_status',
      "TEXT NOT NULL DEFAULT 'idle'",
    );
    this.ensureColumn('stream_config', 'connection_detail', 'TEXT');
    this.ensureColumn('stream_config', 'status_updated_at', 'INTEGER');
    this.ensureColumn('stream_config', 'chat_highlights', 'TEXT');
    this.ensureColumn('room_events', 'nickname', 'TEXT');
    for (const table of FEED_TABLES) {
      this.ensureColumn(table, 'seq', 'INTEGER NOT NULL DEFAULT 0');
      this.tracked.exec(
        `CREATE INDEX IF NOT EXISTS idx_${table}_stream_seq
         ON ${table} (stream_id, seq)`,
      );
    }
    this.tracked.exec(
      `CREATE INDEX IF NOT EXISTS idx_queue_items_stream_status
       ON queue_items (stream_id, status, created_at)`,
    );
    this.backfillSeq();
    this.relaxStreamConfigNullability();
    this.migrateDefaultConfigsToInherit();
  }

  /** Give pre-cursor rows distinct positions so trimming can order by seq. */
  private backfillSeq(): void {
    if (this.ctx.storage.kv.get(SEQ_BACKFILL_KEY) != null) return;
    for (const table of FEED_TABLES) {
      this.tracked.exec(`UPDATE ${table} SET seq = rowid WHERE seq = 0`);
    }
    this.ctx.storage.kv.put(SEQ_BACKFILL_KEY, 1);
  }

  /**
   * Position in this stream's log, shared across chat/events/gifts so a single
   * cursor covers all three. Bumped on edit so changed rows re-sync.
   */
  private nextSeq(): number {
    const seq = this.currentSeq() + 1;
    this.seq = seq;
    this.ctx.storage.kv.put(SEQ_KEY, seq);
    return seq;
  }

  private currentSeq(): number {
    if (this.seq != null) return this.seq;
    const stored = this.ctx.storage.kv.get<number>(SEQ_KEY);
    if (stored != null) {
      this.seq = Number(stored);
      return this.seq;
    }
    let max = 0;
    for (const table of FEED_TABLES) {
      const row = this.tracked
        .exec<{ max_seq: number | null }>(`SELECT MAX(seq) AS max_seq FROM ${table}`)
        .one();
      max = Math.max(max, Number(row.max_seq ?? 0));
    }
    this.ctx.storage.kv.put(SEQ_KEY, max);
    this.seq = max;
    return max;
  }

  /** Recreate stream_config so alert columns can be NULL (inherit global). */
  private relaxStreamConfigNullability(): void {
    const cols = this.tracked
      .exec<{ name: string; notnull: number }>(
        'PRAGMA table_info(stream_config)',
      )
      .toArray();
    const giftCol = cols.find((c) => c.name === 'gift_alert_rules');
    if (!giftCol || giftCol.notnull === 0) return;

    this.tracked.exec(`
      CREATE TABLE stream_config_nullable (
        stream_id TEXT PRIMARY KEY,
        gift_alert_rules TEXT,
        chat_keyword_flags TEXT,
        chat_highlights TEXT,
        is_checked_in INTEGER NOT NULL DEFAULT 0,
        connection_status TEXT NOT NULL DEFAULT 'idle',
        connection_detail TEXT,
        status_updated_at INTEGER
      );
      INSERT INTO stream_config_nullable (
        stream_id, gift_alert_rules, chat_keyword_flags, chat_highlights,
        is_checked_in, connection_status, connection_detail, status_updated_at
      )
      SELECT stream_id, gift_alert_rules, chat_keyword_flags, chat_highlights,
             is_checked_in, connection_status, connection_detail, status_updated_at
      FROM stream_config;
      DROP TABLE stream_config;
      ALTER TABLE stream_config_nullable RENAME TO stream_config;
    `);
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

  private ensureConfig(streamId: string): void {
    const existing = this.tracked
      .exec<{
        stream_id: string;
      }>('SELECT stream_id FROM stream_config WHERE stream_id = ?', streamId)
      .toArray();
    if (existing.length > 0) return;
    this.tracked.exec(
      `INSERT INTO stream_config (
         stream_id, gift_alert_rules, chat_keyword_flags, chat_highlights,
         is_checked_in, connection_status, connection_detail, status_updated_at
       ) VALUES (?, NULL, NULL, NULL, 0, 'idle', NULL, ?)`,
      streamId,
      Date.now(),
    );
  }

  /** Clear stored defaults so streams inherit global settings. */
  private migrateDefaultConfigsToInherit(): void {
    const rows = this.tracked
      .exec<{
        stream_id: string;
        gift_alert_rules: string | null;
        chat_keyword_flags: string | null;
        chat_highlights: string | null;
      }>('SELECT stream_id, gift_alert_rules, chat_keyword_flags, chat_highlights FROM stream_config')
      .toArray();
    for (const row of rows) {
      if (
        row.gift_alert_rules == null &&
        row.chat_keyword_flags == null &&
        row.chat_highlights == null
      ) {
        continue;
      }
      const parsed = parseStoredAlertSettings(row);
      if (!parsed) continue;
      if (!isDefaultAlertSettings(parsed)) continue;
      this.tracked.exec(
        `UPDATE stream_config
         SET gift_alert_rules = NULL, chat_keyword_flags = NULL, chat_highlights = NULL
         WHERE stream_id = ?`,
        row.stream_id,
      );
    }
  }

  private async fetchGlobalSettings(): Promise<GlobalSettings> {
    const now = Date.now();
    if (
      this.globalSettingsCache &&
      now - this.globalSettingsCache.fetchedAt < GLOBAL_SETTINGS_TTL_MS
    ) {
      return this.globalSettingsCache.value;
    }
    try {
      const res = await this.env.REGISTRY.get(
        this.env.REGISTRY.idFromName('global'),
      ).fetch(new Request('https://registry/global-settings'));
      if (res.ok) {
        const value = (await res.json()) as GlobalSettings;
        this.globalSettingsCache = { value, fetchedAt: now };
        return value;
      }
    } catch (err) {
      console.error('Failed to fetch global settings', err);
    }
    return this.globalSettingsCache?.value ?? { ...DEFAULT_GLOBAL_SETTINGS };
  }

  private readOverrides(streamId: string): AlertSettingsOverrides {
    this.ensureConfig(streamId);
    const row = this.tracked
      .exec<{
        gift_alert_rules: string | null;
        chat_keyword_flags: string | null;
        chat_highlights: string | null;
      }>(
        `SELECT gift_alert_rules, chat_keyword_flags, chat_highlights
         FROM stream_config WHERE stream_id = ?`,
        streamId,
      )
      .one();

    const overrides: AlertSettingsOverrides = {};
    if (row.gift_alert_rules != null) {
      try {
        overrides.giftAlertRules = JSON.parse(
          row.gift_alert_rules,
        ) as GiftAlertRule[];
      } catch {
        overrides.giftAlertRules = null;
      }
    } else {
      overrides.giftAlertRules = null;
    }
    if (row.chat_keyword_flags != null) {
      try {
        overrides.chatKeywordFlags = JSON.parse(
          row.chat_keyword_flags,
        ) as string[];
      } catch {
        overrides.chatKeywordFlags = null;
      }
    } else {
      overrides.chatKeywordFlags = null;
    }
    if (row.chat_highlights != null) {
      try {
        overrides.chatHighlights = JSON.parse(
          row.chat_highlights,
        ) as ChatHighlightConfig;
      } catch {
        overrides.chatHighlights = null;
      }
    } else {
      overrides.chatHighlights = null;
    }
    return overrides;
  }

  private async getResolvedConfig(streamId: string): Promise<StreamConfig> {
    this.ensureConfig(streamId);
    const row = this.tracked
      .exec<{
        stream_id: string;
        is_checked_in: number;
      }>('SELECT stream_id, is_checked_in FROM stream_config WHERE stream_id = ?', streamId)
      .one();
    const global = await this.fetchGlobalSettings();
    const overrides = this.readOverrides(streamId);
    const resolved = resolveAlertSettings(global, overrides);
    return {
      streamId: row.stream_id,
      ...resolved,
      isCheckedIn: row.is_checked_in === 1,
      overrides,
      global,
    };
  }

  /**
   * The relay re-reports `offline` every 30s while waiting for a broadcaster,
   * so skip writes that would not change anything.
   */
  private setStatus(
    streamId: string,
    status: ConnectionStatus,
    detail?: string | null,
  ): void {
    const nextDetail = detail ?? null;
    if (
      this.lastStatus?.status === status &&
      this.lastStatus.detail === nextDetail
    ) {
      return;
    }
    this.ensureConfig(streamId);
    this.tracked.exec(
      `UPDATE stream_config
       SET connection_status = ?, connection_detail = ?, status_updated_at = ?
       WHERE stream_id = ?`,
      status,
      nextDetail,
      Date.now(),
      streamId,
    );
    this.lastStatus = { status, detail: nextDetail };
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureMigrated();
    try {
      const response = await this.route(request);
      return response ?? Response.json({ error: 'not found' }, { status: 404 });
    } catch (err) {
      console.error('StreamSession error', err);
      return Response.json(
        { error: err instanceof Error ? err.message : 'internal error' },
        { status: 500 },
      );
    } finally {
      this.ctx.waitUntil(
        Promise.resolve().then(() => this.tracked.flush()),
      );
    }
  }

  private async route(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname;
    const streamId = url.searchParams.get('streamId') ?? '';
    const routeKey = `${request.method} ${path}`;

    switch (routeKey) {
      case 'POST /check-in':
        return this.handleCheckIn(streamId, request);
      case 'POST /check-out':
        return this.handleCheckOut(streamId, request);
      case 'POST /sync-check':
        return this.handleSyncCheck(streamId, request);
      case 'POST /events':
        return this.handleEvent(streamId, (await request.json()) as RelayEvent);
      case 'GET /quota':
        return Response.json(this.tracked.snapshot());
      case 'GET /live':
        return this.handleGetLive(
          streamId,
          parseCursor(url.searchParams.get('since')),
        );
      case 'GET /queue':
        return this.handleGetQueue(
          streamId,
          url.searchParams.get('status') ?? undefined,
        );
      case 'GET /config':
        return Response.json(await this.getResolvedConfig(streamId));
      case 'PUT /config':
        return this.handlePutConfig(streamId, await request.json());
      case 'PATCH /gifts':
        return this.handleSetGiftStatuses(streamId, await request.json());
      default:
        break;
    }

    if (request.method !== 'PATCH') return null;
    if (path.startsWith('/queue/')) {
      return this.handleMarkDone(
        streamId,
        decodeURIComponent(path.slice('/queue/'.length)),
      );
    }
    if (path.startsWith('/gifts/')) {
      return this.handleSetGiftStatus(
        streamId,
        decodeURIComponent(path.slice('/gifts/'.length)),
        await request.json(),
      );
    }
    return null;
  }

  private async handleCheckIn(
    streamId: string,
    request: Request,
  ): Promise<Response> {
    if (!streamId) {
      return Response.json({ error: 'streamId required' }, { status: 400 });
    }
    const body = await readWatcherBody(request);
    if (!body.clientId) {
      return Response.json({ error: 'clientId required' }, { status: 400 });
    }
    this.ensureConfig(streamId);

    const result = await this.env.REGISTRY.get(
      this.env.REGISTRY.idFromName('global'),
    ).fetch(
      new Request('https://registry/check-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamId, clientId: body.clientId }),
      }),
    );
    const payload = (await result.json()) as {
      isCheckedIn?: boolean;
      watcherCount?: number;
      youAreWatching?: boolean;
      error?: string;
    };
    if (!result.ok) {
      return Response.json(payload, { status: result.status });
    }
    this.applyCheckedIn(streamId, payload.isCheckedIn !== false);
    return Response.json({
      ok: true,
      streamId,
      isCheckedIn: payload.isCheckedIn !== false,
      watcherCount: payload.watcherCount ?? 1,
      youAreWatching: payload.youAreWatching !== false,
    });
  }

  private async handleCheckOut(
    streamId: string,
    request: Request,
  ): Promise<Response> {
    if (!streamId) {
      return Response.json({ error: 'streamId required' }, { status: 400 });
    }
    const body = await readWatcherBody(request);
    if (!body.clientId) {
      return Response.json({ error: 'clientId required' }, { status: 400 });
    }
    this.ensureConfig(streamId);

    const result = await this.env.REGISTRY.get(
      this.env.REGISTRY.idFromName('global'),
    ).fetch(
      new Request('https://registry/check-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          streamId,
          clientId: body.clientId,
          force: body.force,
        }),
      }),
    );
    const payload = (await result.json()) as {
      isCheckedIn?: boolean;
      watcherCount?: number;
      youAreWatching?: boolean;
      error?: string;
    };
    if (!result.ok) {
      return Response.json(payload, { status: result.status });
    }
    this.applyCheckedIn(streamId, Boolean(payload.isCheckedIn));
    return Response.json({
      ok: true,
      streamId,
      isCheckedIn: Boolean(payload.isCheckedIn),
      watcherCount: payload.watcherCount ?? 0,
      youAreWatching: Boolean(payload.youAreWatching),
    });
  }

  private async handleSyncCheck(
    streamId: string,
    request: Request,
  ): Promise<Response> {
    if (!streamId) {
      return Response.json({ error: 'streamId required' }, { status: 400 });
    }
    const body = (await request.json()) as { isCheckedIn?: boolean };
    this.applyCheckedIn(streamId, Boolean(body.isCheckedIn));
    return Response.json({ ok: true, streamId, isCheckedIn: Boolean(body.isCheckedIn) });
  }

  private applyCheckedIn(streamId: string, isCheckedIn: boolean): void {
    this.ensureConfig(streamId);
    const row = this.tracked
      .exec<{ is_checked_in: number }>(
        'SELECT is_checked_in FROM stream_config WHERE stream_id = ?',
        streamId,
      )
      .one();
    const was = row.is_checked_in === 1;
    this.tracked.exec(
      'UPDATE stream_config SET is_checked_in = ? WHERE stream_id = ?',
      isCheckedIn ? 1 : 0,
      streamId,
    );
    if (isCheckedIn) {
      this.ctx.waitUntil(this.ctx.storage.deleteAlarm());
    }
    if (was && !isCheckedIn) {
      this.setStatus(streamId, 'idle', 'checked_out');
    } else if (!was && isCheckedIn) {
      this.setStatus(streamId, 'waiting', 'checked_in');
    }
  }

  private async handleEvent(
    streamId: string,
    event: RelayEvent,
  ): Promise<Response> {
    const config = await this.getResolvedConfig(streamId);
    if (
      !config.isCheckedIn &&
      event.kind !== 'disconnected' &&
      event.kind !== 'status'
    ) {
      return Response.json({ ok: true, ignored: true, reason: 'checked_out' });
    }

    switch (event.kind) {
      case 'gift':
        return this.handleGift(streamId, config, event);
      case 'chat':
        return this.handleChat(streamId, config, event);
      case 'room':
        return this.handleRoom(streamId, event);
      case 'status':
        return this.handleStatus(streamId, event);
      case 'disconnected':
        return this.handleDisconnected(streamId, event);
      default:
        return Response.json({ error: 'unknown event' }, { status: 400 });
    }
  }

  private async handleStatus(
    streamId: string,
    event: RelayStatusEvent,
  ): Promise<Response> {
    this.setStatus(streamId, event.status, event.detail ?? null);
    // Broadcaster came back inside the grace period.
    if (event.status === 'live') {
      await this.ctx.storage.deleteAlarm();
    }
    return Response.json({ ok: true });
  }

  private async handleRoom(
    streamId: string,
    event: RelayRoomEvent,
  ): Promise<Response> {
    this.tracked.exec(
      `INSERT INTO room_events (id, stream_id, type, username, nickname, summary, created_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      event.eventId,
      streamId,
      event.type,
      event.username,
      event.nickname ?? null,
      event.summary,
      event.createdAt,
      this.nextSeq(),
    );
    this.trimTable('room_events', streamId, EVENT_LIMIT);
    if (event.type === 'stream_end') {
      await this.ctx.storage.setAlarm(
        Date.now() + AUTO_CHECKOUT_AFTER_STREAM_END_MS,
      );
    }
    return Response.json({ ok: true });
  }

  /**
   * Fires once the post-broadcast grace period elapses. Releasing the check-in
   * stops the relay reconnecting to a stream nobody asked for any more.
   */
  async alarm(): Promise<void> {
    await this.ensureMigrated();
    try {
      const row = this.tracked
        .exec<{
          stream_id: string;
          connection_status: string;
          is_checked_in: number;
        }>(
          `SELECT stream_id, connection_status, is_checked_in
           FROM stream_config LIMIT 1`,
        )
        .toArray()[0];
      if (!row || row.is_checked_in !== 1) return;
      if (row.connection_status === 'live') return;
      await this.autoCheckOut(row.stream_id);
    } catch (err) {
      console.error('StreamSession alarm error', err);
    } finally {
      this.tracked.flush();
    }
  }

  private async autoCheckOut(streamId: string): Promise<void> {
    const result = await this.env.REGISTRY.get(
      this.env.REGISTRY.idFromName('global'),
    ).fetch(
      new Request('https://registry/check-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          streamId,
          clientId: AUTO_CHECKOUT_CLIENT_ID,
          force: true,
        }),
      }),
    );
    if (!result.ok) return;
    const payload = (await result.json()) as { isCheckedIn?: boolean };
    this.applyCheckedIn(streamId, Boolean(payload.isCheckedIn));
  }

  private async handleGift(
    streamId: string,
    config: StreamConfig,
    event: RelayGiftEvent,
  ): Promise<Response> {
    const matched = matchGiftRule(config.giftAlertRules, event);
    let queueItemId: string | null = null;
    const alertStatus: 'none' | 'pending' = 'pending';
    let matchedRule: string | null = null;
    const senderNickname = event.senderNickname ?? null;

    if (matched) {
      const payload: QueueItemPayload = {
        senderUsername: event.senderUsername,
        senderNickname,
        giftName: event.giftName,
        giftCount: event.giftCount,
        diamondValue: event.diamondValue,
        targetUsername: event.targetUsername,
        targetNickname: event.targetNickname,
        matchedRule: matched.label,
      };
      queueItemId = await this.enqueue(
        streamId,
        'gift_threshold',
        payload,
        event.createdAt,
      );
      matchedRule = matched.label;
    }

    this.tracked.exec(
      `INSERT INTO gift_log (
         id, stream_id, sender_username, sender_nickname, gift_name, gift_count, diamond_value,
         target_username, target_nickname, alert_status, queue_item_id, matched_rule, created_at, seq
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.eventId,
      streamId,
      event.senderUsername,
      senderNickname,
      event.giftName,
      event.giftCount,
      event.diamondValue,
      event.targetUsername,
      event.targetNickname,
      alertStatus,
      queueItemId,
      matchedRule,
      event.createdAt,
      this.nextSeq(),
    );
    this.trimTable('gift_log', streamId, GIFT_LIMIT);

    if (matched && queueItemId) {
      const mode =
        config.global?.nameDisplayMode ??
        DEFAULT_GLOBAL_SETTINGS.nameDisplayMode;
      await this.pushAlert({
        title: matched.label,
        body: formatGiftAlertBody(
          {
            ...event,
            senderNickname,
          },
          mode,
        ),
        tag: queueItemId,
        streamId,
        queueItemId,
        actions: [{ action: 'done', title: 'Done' }],
      });
    }

    return Response.json({
      ok: true,
      alerted: Boolean(matched),
      queueItemId,
    });
  }

  private async handleChat(
    streamId: string,
    config: StreamConfig,
    event: RelayChatEvent,
  ): Promise<Response> {
    const keyword = matchChatKeyword(config.chatKeywordFlags, event.comment);
    let queueItemId: string | null = null;
    const nickname = event.userSignals?.nickname ?? null;

    if (keyword) {
      const payload: QueueItemPayload = {
        username: event.username,
        nickname,
        comment: event.comment,
        matchedKeyword: keyword,
      };
      queueItemId = await this.enqueue(
        streamId,
        'flagged_chat',
        payload,
        event.createdAt,
      );
    }

    this.tracked.exec(
      `INSERT INTO chat_log (
         id, stream_id, username, comment, flagged_keyword, queue_item_id,
         is_new_chatter, user_signals, created_at, seq
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.eventId,
      streamId,
      event.username,
      event.comment,
      keyword,
      queueItemId,
      0,
      event.userSignals ? JSON.stringify(event.userSignals) : null,
      event.createdAt,
      this.nextSeq(),
    );
    this.trimTable('chat_log', streamId, CHAT_LIMIT);

    if (keyword && queueItemId) {
      const mode =
        config.global?.nameDisplayMode ??
        DEFAULT_GLOBAL_SETTINGS.nameDisplayMode;
      const who = formatPersonLabel(
        event.username,
        nickname,
        mode,
        'anon',
      );
      await this.pushAlert({
        title: `Flagged chat: ${keyword}`,
        body: `${who}: ${event.comment}`,
        tag: queueItemId,
        streamId,
        queueItemId,
        actions: [{ action: 'done', title: 'Done' }],
      });
    }

    return Response.json({
      ok: true,
      alerted: Boolean(keyword),
      queueItemId,
    });
  }

  private async handleDisconnected(
    streamId: string,
    event: RelayDisconnectedEvent,
  ): Promise<Response> {
    this.setStatus(streamId, 'disconnected', event.reason);
    await this.pushAlert({
      title: 'Disconnected from stream',
      body: `@${streamId}: ${event.reason}`,
      tag: `disconnect-${streamId}-${event.createdAt}`,
      streamId,
      queueItemId: '',
    });
    return Response.json({ ok: true });
  }

  private trimTable(table: FeedTable, streamId: string, keep: number): void {
    const pending = (this.insertsSinceTrim.get(table) ?? 0) + 1;
    if (pending < TRIM_EVERY) {
      this.insertsSinceTrim.set(table, pending);
      return;
    }
    this.insertsSinceTrim.set(table, 0);

    const cutoff = this.tracked
      .exec<{ seq: number }>(
        `SELECT seq FROM ${table} WHERE stream_id = ?
         ORDER BY seq DESC LIMIT 1 OFFSET ?`,
        streamId,
        keep - 1,
      )
      .toArray()[0];
    if (!cutoff) return;

    this.tracked.exec(
      `DELETE FROM ${table} WHERE stream_id = ? AND seq < ?`,
      streamId,
      cutoff.seq,
    );
  }

  private async enqueue(
    streamId: string,
    type: 'gift_threshold' | 'flagged_chat',
    payload: QueueItemPayload,
    createdAt: number,
  ): Promise<string> {
    const id = uuid();
    this.tracked.exec(
      `INSERT INTO queue_items (id, stream_id, type, status, payload, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
      id,
      streamId,
      type,
      JSON.stringify(payload),
      createdAt,
    );
    return id;
  }

  private async handleGetLive(
    streamId: string,
    since: number | null,
  ): Promise<Response> {
    const config = await this.getResolvedConfig(streamId);
    const cfg = this.tracked
      .exec<{
        connection_status: string;
        connection_detail: string | null;
      }>(
        `SELECT connection_status, connection_detail
         FROM stream_config WHERE stream_id = ?`,
        streamId,
      )
      .one();

    const cursor = this.currentSeq();
    // A cursor ahead of ours means the client is talking to a reset log; fall
    // back to a snapshot rather than silently starving it of rows.
    const from = since != null && since <= cursor ? since : null;

    const chatRows = this.readFeedRows<ChatRow>(
      'chat_log',
      streamId,
      from,
      CHAT_LIMIT,
    );

    const queueStatuses = this.queueStatusMap(
      chatRows.map((r) => r.queue_item_id).filter(Boolean) as string[],
    );

    const chat: ChatLogItem[] = chatRows.map((r) => ({
      id: r.id,
      streamId: r.stream_id,
      username: r.username,
      comment: r.comment,
      flaggedKeyword: r.flagged_keyword,
      queueItemId: r.queue_item_id,
      queueStatus: r.queue_item_id
        ? (queueStatuses.get(r.queue_item_id) ?? null)
        : null,
      userSignals: parseUserSignals(r.user_signals),
      createdAt: r.created_at,
    }));

    const events: RoomLogItem[] = this.readFeedRows<RoomRow>(
      'room_events',
      streamId,
      from,
      EVENT_LIMIT,
    ).map((r) => ({
      id: r.id,
      streamId: r.stream_id,
      type: r.type as RoomLogItem['type'],
      username: r.username,
      nickname: r.nickname ?? null,
      summary: r.summary,
      createdAt: r.created_at,
    }));

    const gifts: GiftLogItem[] = this.readFeedRows<GiftRow>(
      'gift_log',
      streamId,
      from,
      GIFT_LIMIT,
    ).map((r) => ({
        id: r.id,
        streamId: r.stream_id,
        senderUsername: r.sender_username,
        senderNickname: r.sender_nickname ?? null,
        giftName: r.gift_name,
        giftCount: r.gift_count,
        diamondValue: r.diamond_value,
        targetUsername: r.target_username,
        targetNickname: r.target_nickname ?? null,
        alertStatus: (r.alert_status || 'none') as GiftLogItem['alertStatus'],
        queueItemId: r.queue_item_id,
        matchedRule: r.matched_rule,
        createdAt: r.created_at,
      }));

    const feed: LiveFeed = {
      streamId,
      status: (cfg.connection_status || 'idle') as ConnectionStatus,
      statusDetail: cfg.connection_detail,
      isCheckedIn: config.isCheckedIn,
      chatHighlights: config.chatHighlights,
      nameDisplayMode:
        config.global?.nameDisplayMode ??
        DEFAULT_GLOBAL_SETTINGS.nameDisplayMode,
      enabledGiftNames: enabledGiftNamesFromRules(config.giftAlertRules),
      chat,
      events,
      gifts,
      cursor,
      incremental: from != null,
    };
    return Response.json(feed);
  }

  /**
   * Rows changed since `since`, or the most recent `limit` when starting fresh.
   * Both paths ride an index, so an idle poll reads next to nothing.
   */
  private readFeedRows<T extends Record<string, SqlStorageValue>>(
    table: FeedTable,
    streamId: string,
    since: number | null,
    limit: number,
  ): T[] {
    if (since != null) {
      return this.tracked
        .exec<T>(
          `SELECT * FROM ${table} WHERE stream_id = ? AND seq > ?
           ORDER BY seq ASC LIMIT ?`,
          streamId,
          since,
          limit,
        )
        .toArray();
    }
    return this.tracked
      .exec<T>(
        `SELECT * FROM ${table} WHERE stream_id = ?
         ORDER BY created_at DESC LIMIT ?`,
        streamId,
        limit,
      )
      .toArray();
  }

  private queueStatusMap(ids: string[]): Map<string, QueueItemStatus> {
    const map = new Map<string, QueueItemStatus>();
    const unique = [...new Set(ids)];
    if (unique.length === 0) return map;
    const rows = this.tracked
      .exec<{ id: string; status: string }>(
        `SELECT id, status FROM queue_items
         WHERE id IN (${unique.map(() => '?').join(', ')})`,
        ...unique,
      )
      .toArray();
    for (const row of rows) {
      map.set(row.id, row.status as QueueItemStatus);
    }
    return map;
  }

  private handleGetQueue(streamId: string, want = 'pending'): Response {
    const rows = this.tracked
      .exec<{
        id: string;
        stream_id: string;
        type: string;
        status: string;
        payload: string;
        created_at: number;
        resolved_at: number | null;
      }>(
        `SELECT * FROM queue_items WHERE stream_id = ? AND status = ?
         ORDER BY created_at DESC LIMIT 200`,
        streamId,
        want,
      )
      .toArray();

    const items: QueueItem[] = rows.map((r) => ({
      id: r.id,
      streamId: r.stream_id,
      type: r.type as QueueItem['type'],
      status: r.status as QueueItem['status'],
      payload: JSON.parse(r.payload) as QueueItemPayload,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
    }));

    return Response.json({ items });
  }

  private handleMarkDone(streamId: string, itemId: string): Response {
    this.tracked.exec(
      `UPDATE queue_items SET status = 'done', resolved_at = ?
       WHERE id = ? AND stream_id = ?`,
      Date.now(),
      itemId,
      streamId,
    );
    this.tracked.exec(
      `UPDATE gift_log SET alert_status = 'done', seq = ?
       WHERE queue_item_id = ? AND stream_id = ?`,
      this.nextSeq(),
      itemId,
      streamId,
    );
    this.touchChatForQueueItem(streamId, itemId);
    return Response.json({ ok: true, id: itemId, status: 'done' });
  }

  /** Chat rows carry the queue status, so republish them when it changes. */
  private touchChatForQueueItem(streamId: string, itemId: string): void {
    this.tracked.exec(
      'UPDATE chat_log SET seq = ? WHERE queue_item_id = ? AND stream_id = ?',
      this.nextSeq(),
      itemId,
      streamId,
    );
  }

  private handleSetGiftStatuses(streamId: string, body: unknown): Response {
    const status =
      body &&
      typeof body === 'object' &&
      'status' in body &&
      ((body as { status?: string }).status === 'pending' ||
        (body as { status?: string }).status === 'done')
        ? (body as { status: 'pending' | 'done' }).status
        : 'done';
    const ids = parseGiftIdList(body);
    let count = 0;
    for (const id of ids) {
      const res = this.handleSetGiftStatus(streamId, id, { status });
      if (res.ok) count += 1;
    }
    return Response.json({ ok: true, count, status });
  }

  private handleSetGiftStatus(
    streamId: string,
    giftId: string,
    body: unknown,
  ): Response {
    const status =
      body &&
      typeof body === 'object' &&
      'status' in body &&
      ((body as { status?: string }).status === 'pending' ||
        (body as { status?: string }).status === 'done')
        ? (body as { status: 'pending' | 'done' }).status
        : 'done';

    const row = this.tracked
      .exec<{
        queue_item_id: string | null;
      }>(
        `SELECT queue_item_id FROM gift_log WHERE id = ? AND stream_id = ?`,
        giftId,
        streamId,
      )
      .toArray()[0];
    if (!row) {
      return Response.json({ error: 'gift not found' }, { status: 404 });
    }

    this.tracked.exec(
      `UPDATE gift_log SET alert_status = ?, seq = ?
       WHERE id = ? AND stream_id = ?`,
      status,
      this.nextSeq(),
      giftId,
      streamId,
    );

    if (row.queue_item_id) {
      if (status === 'done') {
        this.tracked.exec(
          `UPDATE queue_items SET status = 'done', resolved_at = ?
           WHERE id = ? AND stream_id = ?`,
          Date.now(),
          row.queue_item_id,
          streamId,
        );
      } else {
        this.tracked.exec(
          `UPDATE queue_items SET status = 'pending', resolved_at = NULL
           WHERE id = ? AND stream_id = ?`,
          row.queue_item_id,
          streamId,
        );
      }
      this.touchChatForQueueItem(streamId, row.queue_item_id);
    }

    return Response.json({
      ok: true,
      id: giftId,
      queueItemId: row.queue_item_id,
      status,
    });
  }

  private async handlePutConfig(
    streamId: string,
    body: unknown,
  ): Promise<Response> {
    this.ensureConfig(streamId);
    const input = body as {
      giftAlertRules?: GiftAlertRule[] | null;
      chatKeywordFlags?: string[] | null;
      chatHighlights?: ChatHighlightConfig | Partial<ChatHighlightConfig> | null;
      clearOverrides?: boolean;
    };

    if (input.clearOverrides) {
      this.clearAllOverrides(streamId);
      return Response.json(await this.getResolvedConfig(streamId));
    }

    if ('giftAlertRules' in input) {
      this.writeNullableJsonColumn(
        'gift_alert_rules',
        streamId,
        emptyArrayToNull(input.giftAlertRules),
      );
    }
    if ('chatKeywordFlags' in input) {
      this.writeNullableJsonColumn(
        'chat_keyword_flags',
        streamId,
        emptyArrayToNull(input.chatKeywordFlags),
      );
    }
    if ('chatHighlights' in input) {
      this.writeChatHighlightsOverride(streamId, input.chatHighlights);
    }
    return Response.json(await this.getResolvedConfig(streamId));
  }

  private clearAllOverrides(streamId: string): void {
    this.tracked.exec(
      `UPDATE stream_config
       SET gift_alert_rules = NULL, chat_keyword_flags = NULL, chat_highlights = NULL
       WHERE stream_id = ?`,
      streamId,
    );
  }

  private writeNullableJsonColumn(
    column: 'gift_alert_rules' | 'chat_keyword_flags' | 'chat_highlights',
    streamId: string,
    value: unknown,
  ): void {
    this.tracked.exec(
      `UPDATE stream_config SET ${column} = ? WHERE stream_id = ?`,
      value == null ? null : JSON.stringify(value),
      streamId,
    );
  }

  private writeChatHighlightsOverride(
    streamId: string,
    highlights:
      | ChatHighlightConfig
      | Partial<ChatHighlightConfig>
      | null
      | undefined,
  ): void {
    if (highlights == null) {
      this.writeNullableJsonColumn('chat_highlights', streamId, null);
      return;
    }
    const stored = partialHighlightsForStorage(highlights);
    this.writeNullableJsonColumn(
      'chat_highlights',
      streamId,
      Object.keys(stored).length === 0 ? null : stored,
    );
  }

  private async pushAlert(payload: PushNotificationPayload): Promise<void> {
    await this.env.REGISTRY.get(this.env.REGISTRY.idFromName('global')).fetch(
      new Request('https://registry/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );
  }
}

function emptyArrayToNull<T>(value: T[] | null | undefined): T[] | null {
  if (value == null || value.length === 0) return null;
  return value;
}

function partialHighlightsForStorage(
  h: ChatHighlightConfig | Partial<ChatHighlightConfig>,
): Partial<ChatHighlightConfig> {
  const stored: Partial<ChatHighlightConfig> = {};
  if (Array.isArray(h.highlightUsernames)) {
    const usernames = h.highlightUsernames
      .map((u) => u.trim().replace(/^@/, ''))
      .filter(Boolean);
    if (usernames.length > 0) stored.highlightUsernames = usernames;
  }
  if (typeof h.highlightRecentGifters === 'boolean') {
    stored.highlightRecentGifters = h.highlightRecentGifters;
  }
  if (typeof h.recentGifterMinDiamonds === 'number') {
    stored.recentGifterMinDiamonds = h.recentGifterMinDiamonds;
  }
  if (typeof h.recentGifterWindowSeconds === 'number') {
    stored.recentGifterWindowSeconds = h.recentGifterWindowSeconds;
  }
  return stored;
}

function parseStoredAlertSettings(row: {
  gift_alert_rules: string | null;
  chat_keyword_flags: string | null;
  chat_highlights: string | null;
}): {
  giftAlertRules: GiftAlertRule[];
  chatKeywordFlags: string[];
  chatHighlights: ChatHighlightConfig;
} | null {
  try {
    const giftAlertRules = row.gift_alert_rules
      ? (JSON.parse(row.gift_alert_rules) as GiftAlertRule[])
      : [];
    const chatKeywordFlags = row.chat_keyword_flags
      ? (JSON.parse(row.chat_keyword_flags) as string[])
      : [];
    const chatHighlights = row.chat_highlights
      ? {
          ...DEFAULT_CHAT_HIGHLIGHTS,
          ...(JSON.parse(row.chat_highlights) as ChatHighlightConfig),
        }
      : { ...DEFAULT_CHAT_HIGHLIGHTS };
    return { giftAlertRules, chatKeywordFlags, chatHighlights };
  } catch {
    return null;
  }
}

function parseCursor(raw: string | null): number | null {
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseUserSignals(raw: string | null): ChatUserSignals | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ChatUserSignals;
  } catch {
    return null;
  }
}

export function enabledGiftNamesFromRules(
  raw: string | GiftAlertRule[],
): string[] {
  let rules: GiftAlertRule[];
  if (typeof raw === 'string') {
    try {
      rules = JSON.parse(raw) as GiftAlertRule[];
    } catch {
      return [];
    }
  } else {
    rules = raw;
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const name = rule.giftName?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function parseGiftIdList(body: unknown): string[] {
  if (!body || typeof body !== 'object' || !('ids' in body)) return [];
  const raw = (body as { ids?: unknown }).ids;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= GIFT_LIMIT) break;
  }
  return ids;
}

export function matchGiftRule(
  rules: GiftAlertRule[],
  event: RelayGiftEvent,
): GiftAlertRule | null {
  for (const rule of rules) {
    if (rule.notify === false) continue;
    if (rule.giftName) {
      if (event.giftName?.toLowerCase() === rule.giftName.toLowerCase()) {
        return rule;
      }
      continue;
    }
    if (
      typeof rule.minDiamondValue === 'number' &&
      giftDiamondSpend(event.diamondValue, event.giftCount) >=
        rule.minDiamondValue
    ) {
      return rule;
    }
  }
  return null;
}

export function matchChatKeyword(
  keywords: string[],
  comment: string,
): string | null {
  const lower = comment.toLowerCase();
  for (const kw of keywords) {
    if (!kw) continue;
    if (lower.includes(kw.toLowerCase())) {
      return kw;
    }
  }
  return null;
}
