import {
  DEFAULT_CHAT_HIGHLIGHTS,
  DEFAULT_CHAT_KEYWORDS,
  DEFAULT_GIFT_ALERT_RULES,
  type ChatHighlightConfig,
  type ChatLogItem,
  type ChatUserSignals,
  type ConnectionStatus,
  type GiftAlertRule,
  type GiftLogItem,
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
import type { Env } from './env';

const CHAT_LIMIT = 200;
const EVENT_LIMIT = 200;
const GIFT_LIMIT = 200;

function uuid(): string {
  return crypto.randomUUID();
}

export class StreamSession implements DurableObject {
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
        gift_name TEXT,
        gift_count INTEGER,
        diamond_value INTEGER,
        target_username TEXT,
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
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stream_config (
        stream_id TEXT PRIMARY KEY,
        gift_alert_rules TEXT NOT NULL,
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
  }

  private ensureColumn(table: string, column: string, typeSql: string): void {
    try {
      this.ctx.storage.sql.exec(
        `ALTER TABLE ${table} ADD COLUMN ${column} ${typeSql}`,
      );
    } catch {
      // column already exists
    }
  }

  private ensureConfig(streamId: string): void {
    const existing = this.ctx.storage.sql
      .exec<{
        stream_id: string;
      }>('SELECT stream_id FROM stream_config WHERE stream_id = ?', streamId)
      .toArray();
    if (existing.length > 0) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO stream_config (
         stream_id, gift_alert_rules, chat_keyword_flags, chat_highlights,
         is_checked_in, connection_status, connection_detail, status_updated_at
       ) VALUES (?, ?, ?, ?, 0, 'idle', NULL, ?)`,
      streamId,
      JSON.stringify(DEFAULT_GIFT_ALERT_RULES),
      JSON.stringify(DEFAULT_CHAT_KEYWORDS),
      JSON.stringify(DEFAULT_CHAT_HIGHLIGHTS),
      Date.now(),
    );
  }

  private parseHighlights(raw: string | null | undefined): ChatHighlightConfig {
    if (!raw) return { ...DEFAULT_CHAT_HIGHLIGHTS };
    try {
      return {
        ...DEFAULT_CHAT_HIGHLIGHTS,
        ...(JSON.parse(raw) as ChatHighlightConfig),
      };
    } catch {
      return { ...DEFAULT_CHAT_HIGHLIGHTS };
    }
  }

  private getConfig(streamId: string): StreamConfig {
    this.ensureConfig(streamId);
    const row = this.ctx.storage.sql
      .exec<{
        stream_id: string;
        gift_alert_rules: string;
        chat_keyword_flags: string | null;
        chat_highlights: string | null;
        is_checked_in: number;
      }>('SELECT * FROM stream_config WHERE stream_id = ?', streamId)
      .one();

    return {
      streamId: row.stream_id,
      giftAlertRules: JSON.parse(row.gift_alert_rules) as GiftAlertRule[],
      chatKeywordFlags: JSON.parse(row.chat_keyword_flags ?? '[]') as string[],
      chatHighlights: this.parseHighlights(row.chat_highlights),
      isCheckedIn: row.is_checked_in === 1,
    };
  }

  private setStatus(
    streamId: string,
    status: ConnectionStatus,
    detail?: string | null,
  ): void {
    this.ensureConfig(streamId);
    this.ctx.storage.sql.exec(
      `UPDATE stream_config
       SET connection_status = ?, connection_detail = ?, status_updated_at = ?
       WHERE stream_id = ?`,
      status,
      detail ?? null,
      Date.now(),
      streamId,
    );
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
    }
  }

  private async route(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname;
    const streamId = url.searchParams.get('streamId') ?? '';
    const routeKey = `${request.method} ${path}`;

    switch (routeKey) {
      case 'POST /check-in':
        return this.handleCheckIn(streamId);
      case 'POST /check-out':
        return this.handleCheckOut(streamId);
      case 'POST /events':
        return this.handleEvent(streamId, (await request.json()) as RelayEvent);
      case 'GET /live':
        return this.handleGetLive(streamId);
      case 'GET /queue':
        return this.handleGetQueue(
          streamId,
          url.searchParams.get('status') ?? undefined,
        );
      case 'GET /config':
        return Response.json(this.getConfig(streamId));
      case 'PUT /config':
        return this.handlePutConfig(streamId, await request.json());
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

  private async handleCheckIn(streamId: string): Promise<Response> {
    if (!streamId) {
      return Response.json({ error: 'streamId required' }, { status: 400 });
    }
    this.ensureConfig(streamId);
    this.ctx.storage.sql.exec(
      'UPDATE stream_config SET is_checked_in = 1 WHERE stream_id = ?',
      streamId,
    );
    this.setStatus(streamId, 'waiting', 'checked_in');

    await this.env.REGISTRY.get(this.env.REGISTRY.idFromName('global')).fetch(
      new Request('https://registry/check-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamId }),
      }),
    );

    return Response.json({ ok: true, streamId, isCheckedIn: true });
  }

  private async handleCheckOut(streamId: string): Promise<Response> {
    if (!streamId) {
      return Response.json({ error: 'streamId required' }, { status: 400 });
    }
    this.ensureConfig(streamId);
    this.ctx.storage.sql.exec(
      'UPDATE stream_config SET is_checked_in = 0 WHERE stream_id = ?',
      streamId,
    );
    this.setStatus(streamId, 'idle', 'checked_out');

    await this.env.REGISTRY.get(this.env.REGISTRY.idFromName('global')).fetch(
      new Request('https://registry/check-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamId }),
      }),
    );

    return Response.json({ ok: true, streamId, isCheckedIn: false });
  }

  private async handleEvent(
    streamId: string,
    event: RelayEvent,
  ): Promise<Response> {
    const config = this.getConfig(streamId);
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

  private handleStatus(streamId: string, event: RelayStatusEvent): Response {
    this.setStatus(streamId, event.status, event.detail ?? null);
    return Response.json({ ok: true });
  }

  private handleRoom(streamId: string, event: RelayRoomEvent): Response {
    this.ctx.storage.sql.exec(
      `INSERT INTO room_events (id, stream_id, type, username, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      event.eventId,
      streamId,
      event.type,
      event.username,
      event.summary,
      event.createdAt,
    );
    this.trimTable('room_events', streamId, EVENT_LIMIT);
    return Response.json({ ok: true });
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

    if (matched) {
      const payload: QueueItemPayload = {
        senderUsername: event.senderUsername,
        giftName: event.giftName,
        giftCount: event.giftCount,
        diamondValue: event.diamondValue,
        targetUsername: event.targetUsername,
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

    this.ctx.storage.sql.exec(
      `INSERT INTO gift_log (
         id, stream_id, sender_username, gift_name, gift_count, diamond_value,
         target_username, alert_status, queue_item_id, matched_rule, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.eventId,
      streamId,
      event.senderUsername,
      event.giftName,
      event.giftCount,
      event.diamondValue,
      event.targetUsername,
      alertStatus,
      queueItemId,
      matchedRule,
      event.createdAt,
    );
    this.trimTable('gift_log', streamId, GIFT_LIMIT);

    if (matched && queueItemId) {
      await this.pushAlert({
        title: matched.label,
        body: `${event.senderUsername ?? 'someone'} sent ${event.giftName ?? 'gift'} ×${event.giftCount}`,
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

    if (keyword) {
      const payload: QueueItemPayload = {
        username: event.username,
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

    this.ctx.storage.sql.exec(
      `INSERT INTO chat_log (
         id, stream_id, username, comment, flagged_keyword, queue_item_id,
         is_new_chatter, user_signals, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.eventId,
      streamId,
      event.username,
      event.comment,
      keyword,
      queueItemId,
      0,
      event.userSignals ? JSON.stringify(event.userSignals) : null,
      event.createdAt,
    );
    this.trimTable('chat_log', streamId, CHAT_LIMIT);

    if (keyword && queueItemId) {
      await this.pushAlert({
        title: `Flagged chat: ${keyword}`,
        body: `${event.username ?? 'anon'}: ${event.comment}`,
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

  private trimTable(
    table: 'chat_log' | 'room_events' | 'gift_log',
    streamId: string,
    keep: number,
  ): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM ${table}
       WHERE stream_id = ?
         AND id NOT IN (
           SELECT id FROM ${table}
           WHERE stream_id = ?
           ORDER BY created_at DESC
           LIMIT ?
         )`,
      streamId,
      streamId,
      keep,
    );
  }

  private async enqueue(
    streamId: string,
    type: 'gift_threshold' | 'flagged_chat',
    payload: QueueItemPayload,
    createdAt: number,
  ): Promise<string> {
    const id = uuid();
    this.ctx.storage.sql.exec(
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

  private handleGetLive(streamId: string): Response {
    this.ensureConfig(streamId);
    const cfg = this.ctx.storage.sql
      .exec<{
        is_checked_in: number;
        connection_status: string;
        connection_detail: string | null;
        chat_highlights: string | null;
      }>(
        `SELECT is_checked_in, connection_status, connection_detail, chat_highlights
         FROM stream_config WHERE stream_id = ?`,
        streamId,
      )
      .one();

    const chatRows = this.ctx.storage.sql
      .exec<{
        id: string;
        stream_id: string;
        username: string | null;
        comment: string;
        flagged_keyword: string | null;
        queue_item_id: string | null;
        user_signals: string | null;
        created_at: number;
      }>(
        `SELECT * FROM chat_log WHERE stream_id = ?
         ORDER BY created_at DESC LIMIT ?`,
        streamId,
        CHAT_LIMIT,
      )
      .toArray();

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

    const events: RoomLogItem[] = this.ctx.storage.sql
      .exec<{
        id: string;
        stream_id: string;
        type: string;
        username: string | null;
        summary: string;
        created_at: number;
      }>(
        `SELECT * FROM room_events WHERE stream_id = ?
         ORDER BY created_at DESC LIMIT ?`,
        streamId,
        EVENT_LIMIT,
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        streamId: r.stream_id,
        type: r.type as RoomLogItem['type'],
        username: r.username,
        summary: r.summary,
        createdAt: r.created_at,
      }));

    const gifts: GiftLogItem[] = this.ctx.storage.sql
      .exec<{
        id: string;
        stream_id: string;
        sender_username: string | null;
        gift_name: string | null;
        gift_count: number;
        diamond_value: number | null;
        target_username: string | null;
        alert_status: string;
        queue_item_id: string | null;
        matched_rule: string | null;
        created_at: number;
      }>(
        `SELECT * FROM gift_log WHERE stream_id = ?
         ORDER BY created_at DESC LIMIT ?`,
        streamId,
        GIFT_LIMIT,
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        streamId: r.stream_id,
        senderUsername: r.sender_username,
        giftName: r.gift_name,
        giftCount: r.gift_count,
        diamondValue: r.diamond_value,
        targetUsername: r.target_username,
        alertStatus: (r.alert_status || 'none') as GiftLogItem['alertStatus'],
        queueItemId: r.queue_item_id,
        matchedRule: r.matched_rule,
        createdAt: r.created_at,
      }));

    const feed: LiveFeed = {
      streamId,
      status: (cfg.connection_status || 'idle') as ConnectionStatus,
      statusDetail: cfg.connection_detail,
      isCheckedIn: cfg.is_checked_in === 1,
      chatHighlights: this.parseHighlights(cfg.chat_highlights),
      chat,
      events,
      gifts,
    };
    return Response.json(feed);
  }

  private queueStatusMap(ids: string[]): Map<string, QueueItemStatus> {
    const map = new Map<string, QueueItemStatus>();
    if (ids.length === 0) return map;
    for (const id of ids) {
      const rows = this.ctx.storage.sql
        .exec<{
          status: string;
        }>('SELECT status FROM queue_items WHERE id = ?', id)
        .toArray();
      if (rows[0]) {
        map.set(id, rows[0].status as QueueItemStatus);
      }
    }
    return map;
  }

  private handleGetQueue(streamId: string, want = 'pending'): Response {
    const rows = this.ctx.storage.sql
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
    this.ctx.storage.sql.exec(
      `UPDATE queue_items SET status = 'done', resolved_at = ?
       WHERE id = ? AND stream_id = ?`,
      Date.now(),
      itemId,
      streamId,
    );
    this.ctx.storage.sql.exec(
      `UPDATE gift_log SET alert_status = 'done'
       WHERE queue_item_id = ? AND stream_id = ?`,
      itemId,
      streamId,
    );
    return Response.json({ ok: true, id: itemId, status: 'done' });
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

    const row = this.ctx.storage.sql
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

    this.ctx.storage.sql.exec(
      `UPDATE gift_log SET alert_status = ?
       WHERE id = ? AND stream_id = ?`,
      status,
      giftId,
      streamId,
    );

    if (row.queue_item_id) {
      if (status === 'done') {
        this.ctx.storage.sql.exec(
          `UPDATE queue_items SET status = 'done', resolved_at = ?
           WHERE id = ? AND stream_id = ?`,
          Date.now(),
          row.queue_item_id,
          streamId,
        );
      } else {
        this.ctx.storage.sql.exec(
          `UPDATE queue_items SET status = 'pending', resolved_at = NULL
           WHERE id = ? AND stream_id = ?`,
          row.queue_item_id,
          streamId,
        );
      }
    }

    return Response.json({
      ok: true,
      id: giftId,
      queueItemId: row.queue_item_id,
      status,
    });
  }

  private handlePutConfig(streamId: string, body: unknown): Response {
    this.ensureConfig(streamId);
    const input = body as {
      giftAlertRules?: GiftAlertRule[];
      chatKeywordFlags?: string[];
      chatHighlights?: ChatHighlightConfig;
    };
    if (input.giftAlertRules) {
      this.ctx.storage.sql.exec(
        'UPDATE stream_config SET gift_alert_rules = ? WHERE stream_id = ?',
        JSON.stringify(input.giftAlertRules),
        streamId,
      );
    }
    if (input.chatKeywordFlags) {
      this.ctx.storage.sql.exec(
        'UPDATE stream_config SET chat_keyword_flags = ? WHERE stream_id = ?',
        JSON.stringify(input.chatKeywordFlags),
        streamId,
      );
    }
    if (input.chatHighlights) {
      const merged = {
        ...DEFAULT_CHAT_HIGHLIGHTS,
        ...input.chatHighlights,
        highlightUsernames: (input.chatHighlights.highlightUsernames ?? [])
          .map((u) => u.trim().replace(/^@/, ''))
          .filter(Boolean),
      };
      this.ctx.storage.sql.exec(
        'UPDATE stream_config SET chat_highlights = ? WHERE stream_id = ?',
        JSON.stringify(merged),
        streamId,
      );
    }
    return Response.json(this.getConfig(streamId));
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

function parseUserSignals(raw: string | null): ChatUserSignals | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ChatUserSignals;
  } catch {
    return null;
  }
}

export function matchGiftRule(
  rules: GiftAlertRule[],
  event: RelayGiftEvent,
): GiftAlertRule | null {
  for (const rule of rules) {
    if (rule.giftName) {
      if (event.giftName?.toLowerCase() === rule.giftName.toLowerCase()) {
        return rule;
      }
      continue;
    }
    if (
      typeof rule.minDiamondValue === 'number' &&
      typeof event.diamondValue === 'number' &&
      event.diamondValue >= rule.minDiamondValue
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
