/** Shared types for relay ↔ worker ↔ PWA. */

export type QueueItemType = 'gift_threshold' | 'flagged_chat';

export type QueueItemStatus = 'pending' | 'done';

export type ConnectionStatus =
  | 'idle'
  | 'waiting'
  | 'live'
  | 'offline'
  | 'disconnected';

export type RoomEventType =
  | 'follow'
  | 'share'
  | 'like'
  | 'member'
  | 'subscribe'
  | 'stream_end'
  | 'other';

export interface GiftAlertRule {
  /** Match a specific gift name (case-insensitive). */
  giftName?: string;
  /** Alert when total diamonds spent (unit × count) is >= this. */
  minDiamondValue?: number;
  /** Short label shown in the queue / notification. */
  label: string;
  /**
   * When false, the rule is kept for feed pills / settings but does not
   * enqueue or push. Omitted / true = notify (backward compatible).
   */
  notify?: boolean;
}

export { dedupeGiftCatalogByName, GIFT_CATALOG } from './gift-catalog.js';
export type { GiftCatalogItem } from './gift-catalog.js';

export interface ChatHighlightConfig {
  /** Usernames (uniqueId) always highlighted in chat. */
  highlightUsernames: string[];
  /** Highlight chat from people who recently sent a gift. */
  highlightRecentGifters: boolean;
  /** Min diamond value for "recent gifter" highlight. */
  recentGifterMinDiamonds: number;
  /** How long after a gift their chat stays highlighted (seconds). */
  recentGifterWindowSeconds: number;
}

export const DEFAULT_CHAT_HIGHLIGHTS: ChatHighlightConfig = {
  highlightUsernames: [],
  highlightRecentGifters: true,
  recentGifterMinDiamonds: 1,
  recentGifterWindowSeconds: 120,
};

export interface AlertSettings {
  giftAlertRules: GiftAlertRule[];
  chatKeywordFlags: string[];
  chatHighlights: ChatHighlightConfig;
}

export interface AlertSettingsOverrides {
  giftAlertRules?: GiftAlertRule[] | null;
  chatKeywordFlags?: string[] | null;
  chatHighlights?: Partial<ChatHighlightConfig> | null;
}

export type NameDisplayMode = 'username' | 'nickname' | 'both';

export const DEFAULT_NAME_DISPLAY_MODE: NameDisplayMode = 'username';

export interface GlobalSettings extends AlertSettings {
  nameDisplayMode: NameDisplayMode;
}

export interface StreamConfig extends AlertSettings {
  streamId: string;
  isCheckedIn: boolean;
  /** Stored per-stream overrides (null/empty fields inherit global). */
  overrides?: AlertSettingsOverrides;
  /** App-wide defaults used when resolving effective settings. */
  global?: GlobalSettings;
}

export const DEFAULT_GIFT_ALERT_RULES: GiftAlertRule[] = [
  { minDiamondValue: 100, label: 'Gift ≥ 100 diamonds' },
];

export const DEFAULT_CHAT_KEYWORDS: string[] = [];

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  giftAlertRules: DEFAULT_GIFT_ALERT_RULES,
  chatKeywordFlags: DEFAULT_CHAT_KEYWORDS,
  chatHighlights: DEFAULT_CHAT_HIGHLIGHTS,
};

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  ...DEFAULT_ALERT_SETTINGS,
  nameDisplayMode: DEFAULT_NAME_DISPLAY_MODE,
};

function isDiamondRule(rule: GiftAlertRule): boolean {
  return typeof rule.minDiamondValue === 'number' && !rule.giftName;
}

function isNamedGiftRule(rule: GiftAlertRule): boolean {
  return Boolean(rule.giftName?.trim());
}

function splitGiftRules(rules: GiftAlertRule[]): {
  diamond: GiftAlertRule | undefined;
  named: GiftAlertRule[];
} {
  return {
    diamond: rules.find(isDiamondRule),
    named: rules.filter(isNamedGiftRule),
  };
}

function mergeGiftAlertRules(
  globalRules: GiftAlertRule[],
  overrideRules: GiftAlertRule[] | null | undefined,
): GiftAlertRule[] {
  if (overrideRules == null || overrideRules.length === 0) {
    return globalRules;
  }
  const global = splitGiftRules(globalRules);
  const over = splitGiftRules(overrideRules);
  const hasDiamondOverride = over.diamond != null;
  const hasNamedOverride = over.named.length > 0;
  if (!hasDiamondOverride && !hasNamedOverride) {
    return globalRules;
  }
  const diamond = hasDiamondOverride ? over.diamond : global.diamond;
  const named = hasNamedOverride ? over.named : global.named;
  return [...(diamond ? [diamond] : []), ...named];
}

function mergeChatHighlights(
  global: ChatHighlightConfig,
  override: Partial<ChatHighlightConfig> | null | undefined,
): ChatHighlightConfig {
  if (!override) return { ...global };
  const usernames = override.highlightUsernames;
  return {
    highlightUsernames:
      usernames != null && usernames.length > 0
        ? usernames
        : global.highlightUsernames,
    highlightRecentGifters:
      typeof override.highlightRecentGifters === 'boolean'
        ? override.highlightRecentGifters
        : global.highlightRecentGifters,
    recentGifterMinDiamonds:
      typeof override.recentGifterMinDiamonds === 'number'
        ? override.recentGifterMinDiamonds
        : global.recentGifterMinDiamonds,
    recentGifterWindowSeconds:
      typeof override.recentGifterWindowSeconds === 'number'
        ? override.recentGifterWindowSeconds
        : global.recentGifterWindowSeconds,
  };
}

/** Resolve effective alert settings: per-stream overrides replace when set. */
export function resolveAlertSettings(
  global: AlertSettings,
  overrides?: AlertSettingsOverrides | null,
): AlertSettings {
  const o = overrides ?? {};
  const keywords = o.chatKeywordFlags;
  return {
    giftAlertRules: mergeGiftAlertRules(
      global.giftAlertRules,
      o.giftAlertRules,
    ),
    chatKeywordFlags:
      keywords != null && keywords.length > 0
        ? keywords
        : global.chatKeywordFlags,
    chatHighlights: mergeChatHighlights(
      global.chatHighlights,
      o.chatHighlights,
    ),
  };
}

/** True when stored config matches code defaults (migrate to inherit). */
export function isDefaultAlertSettings(settings: AlertSettings): boolean {
  const diamond = settings.giftAlertRules.find(isDiamondRule);
  const named = settings.giftAlertRules.filter(isNamedGiftRule);
  if (named.length > 0) return false;
  if (
    diamond &&
    (diamond.minDiamondValue !== 100 || diamond.notify === false)
  ) {
    return false;
  }
  if (!diamond && settings.giftAlertRules.length > 0) return false;
  if (settings.chatKeywordFlags.length > 0) return false;
  const h = settings.chatHighlights;
  if (h.highlightUsernames.length > 0) return false;
  if (
    h.highlightRecentGifters !== DEFAULT_CHAT_HIGHLIGHTS.highlightRecentGifters
  ) {
    return false;
  }
  if (
    h.recentGifterMinDiamonds !==
    DEFAULT_CHAT_HIGHLIGHTS.recentGifterMinDiamonds
  ) {
    return false;
  }
  if (
    h.recentGifterWindowSeconds !==
    DEFAULT_CHAT_HIGHLIGHTS.recentGifterWindowSeconds
  ) {
    return false;
  }
  return true;
}

export function parseNameDisplayMode(value: unknown): NameDisplayMode {
  if (value === 'username' || value === 'nickname' || value === 'both') {
    return value;
  }
  return DEFAULT_NAME_DISPLAY_MODE;
}

export interface RelayGiftEvent {
  kind: 'gift';
  streamId: string;
  eventId: string;
  senderUsername: string | null;
  senderNickname?: string | null;
  giftName: string | null;
  giftId: number | null;
  giftCount: number;
  diamondValue: number | null;
  targetUsername: string | null;
  targetNickname: string | null;
  createdAt: number;
}

export interface RelayChatEvent {
  kind: 'chat';
  streamId: string;
  eventId: string;
  username: string | null;
  comment: string;
  /** Profile / loyalty signals from TikTok chat payload (optional). */
  userSignals: ChatUserSignals | null;
  createdAt: number;
}

/** Compact loyalty / status fields extracted from WebcastChatMessage.user. */
export interface ChatUserSignals {
  nickname: string | null;
  isSubscriber: boolean;
  isFollower: boolean;
  isModerator: boolean;
  isGiftGiver: boolean;
  fansClubName: string | null;
  fansClubLevel: number | null;
  payGradeName: string | null;
  payGradeLevel: number | null;
  payScore: number | null;
  followerCount: number | null;
  /** Short text labels from badgeList when available. */
  badgeLabels: string[];
}

export interface RelayRoomEvent {
  kind: 'room';
  streamId: string;
  eventId: string;
  type: RoomEventType;
  username: string | null;
  nickname?: string | null;
  /** Verb-only text (e.g. "followed"); person label is formatted client-side. */
  summary: string;
  createdAt: number;
}

export interface RelayStatusEvent {
  kind: 'status';
  streamId: string;
  status: ConnectionStatus;
  detail?: string;
  createdAt: number;
}

export interface RelayDisconnectedEvent {
  kind: 'disconnected';
  streamId: string;
  reason: string;
  createdAt: number;
}

export type RelayEvent =
  | RelayGiftEvent
  | RelayChatEvent
  | RelayRoomEvent
  | RelayStatusEvent
  | RelayDisconnectedEvent;

export interface QueueItemPayload {
  senderUsername?: string | null;
  senderNickname?: string | null;
  giftName?: string | null;
  giftCount?: number;
  diamondValue?: number | null;
  targetUsername?: string | null;
  targetNickname?: string | null;
  username?: string | null;
  nickname?: string | null;
  comment?: string;
  matchedRule?: string;
  matchedKeyword?: string;
}

export interface QueueItem {
  id: string;
  streamId: string;
  type: QueueItemType;
  status: QueueItemStatus;
  payload: QueueItemPayload;
  createdAt: number;
  resolvedAt: number | null;
}

export interface ChatLogItem {
  id: string;
  streamId: string;
  username: string | null;
  comment: string;
  flaggedKeyword: string | null;
  queueItemId: string | null;
  queueStatus: QueueItemStatus | null;
  userSignals: ChatUserSignals | null;
  createdAt: number;
}

export interface RoomLogItem {
  id: string;
  streamId: string;
  type: RoomEventType;
  username: string | null;
  nickname: string | null;
  summary: string;
  createdAt: number;
}

export interface GiftLogItem {
  id: string;
  streamId: string;
  senderUsername: string | null;
  senderNickname: string | null;
  giftName: string | null;
  giftCount: number;
  diamondValue: number | null;
  targetUsername: string | null;
  targetNickname: string | null;
  /** none = logged only; pending/done = alert queue state */
  alertStatus: 'none' | QueueItemStatus;
  queueItemId: string | null;
  matchedRule: string | null;
  createdAt: number;
}

export interface LiveFeed {
  streamId: string;
  status: ConnectionStatus;
  statusDetail: string | null;
  isCheckedIn: boolean;
  chatHighlights: ChatHighlightConfig;
  nameDisplayMode: NameDisplayMode;
  /** Gift names enabled in stream settings (feed pills), regardless of notify. */
  enabledGiftNames: string[];
  chat: ChatLogItem[];
  events: RoomLogItem[];
  gifts: GiftLogItem[];
}

export interface CheckedInStream {
  streamId: string;
  checkedInAt: number;
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  tag: string;
  streamId: string;
  queueItemId: string;
  actions?: Array<{ action: string; title: string }>;
}

/** Total diamonds spent for a gift event (unit value × combo/repeat count). */
export function giftDiamondSpend(
  diamondValue: number | null | undefined,
  giftCount: number | null | undefined,
): number {
  if (typeof diamondValue !== 'number') return 0;
  const count = giftCount && giftCount > 0 ? giftCount : 1;
  return diamondValue * count;
}

/**
 * Format a person for UI / push.
 * - username: @handle
 * - nickname: display name, fall back to @handle
 * - both: "Jane @jane123" when they differ; else @handle
 */
export function formatPersonLabel(
  username: string | null | undefined,
  nickname: string | null | undefined,
  mode: NameDisplayMode = DEFAULT_NAME_DISPLAY_MODE,
  fallback = 'someone',
): string {
  const handle = username?.trim() || null;
  const nick = nickname?.trim() || null;
  const atHandle = handle ? `@${handle}` : null;

  if (mode === 'username') {
    return atHandle ?? nick ?? fallback;
  }
  if (mode === 'nickname') {
    return nick ?? atHandle ?? fallback;
  }
  // both
  if (handle && nick && nick.toLowerCase() !== handle.toLowerCase()) {
    return `${nick} ${atHandle}`;
  }
  return atHandle ?? nick ?? fallback;
}

export function formatGiftTarget(
  username: string | null | undefined,
  nickname?: string | null,
  mode: NameDisplayMode = DEFAULT_NAME_DISPLAY_MODE,
): string | null {
  const handle = username?.trim() || null;
  const nick = nickname?.trim() || null;
  if (!handle && !nick) return null;
  return formatPersonLabel(username, nickname, mode, nick ?? `@${handle}`);
}

export function formatGiftAlertBody(
  input: {
    senderUsername: string | null;
    senderNickname?: string | null;
    giftName: string | null;
    giftCount: number;
    diamondValue?: number | null;
    targetUsername: string | null;
    targetNickname?: string | null;
  },
  mode: NameDisplayMode = DEFAULT_NAME_DISPLAY_MODE,
): string {
  const sender = formatPersonLabel(
    input.senderUsername,
    input.senderNickname,
    mode,
    'someone',
  );
  const gift = input.giftName ?? 'gift';
  const to = formatGiftTarget(input.targetUsername, input.targetNickname, mode);
  const toPart = to ? ` to ${to}` : '';
  const spend = giftDiamondSpend(input.diamondValue, input.giftCount);
  const valuePart =
    typeof input.diamondValue === 'number'
      ? ` ${spend}◆`
      : ` ×${input.giftCount}`;
  return `${sender} sent ${gift}${valuePart}${toPart}`;
}
