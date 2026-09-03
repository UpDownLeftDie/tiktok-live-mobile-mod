/** Shared types for relay ↔ worker ↔ PWA. */

export type QueueItemType = "gift_threshold" | "flagged_chat";

export type QueueItemStatus = "pending" | "done";

export type ConnectionStatus =
  | "idle"
  | "waiting"
  | "live"
  | "offline"
  | "disconnected";

export type RoomEventType =
  | "follow"
  | "share"
  | "like"
  | "member"
  | "subscribe"
  | "stream_end"
  | "other";

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

export type { GiftCatalogItem } from "./gift-catalog.js";
export {
  GIFT_CATALOG,
  dedupeGiftCatalogByName,
} from "./gift-catalog.js";

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

export interface StreamConfig {
  streamId: string;
  giftAlertRules: GiftAlertRule[];
  chatKeywordFlags: string[];
  chatHighlights: ChatHighlightConfig;
  isCheckedIn: boolean;
}

export const DEFAULT_GIFT_ALERT_RULES: GiftAlertRule[] = [
  { minDiamondValue: 100, label: "Gift ≥ 100 diamonds" },
];

export const DEFAULT_CHAT_KEYWORDS: string[] = [];

export interface RelayGiftEvent {
  kind: "gift";
  streamId: string;
  eventId: string;
  senderUsername: string | null;
  giftName: string | null;
  giftId: number | null;
  giftCount: number;
  diamondValue: number | null;
  targetUsername: string | null;
  targetNickname: string | null;
  createdAt: number;
}

export interface RelayChatEvent {
  kind: "chat";
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
  kind: "room";
  streamId: string;
  eventId: string;
  type: RoomEventType;
  username: string | null;
  summary: string;
  createdAt: number;
}

export interface RelayStatusEvent {
  kind: "status";
  streamId: string;
  status: ConnectionStatus;
  detail?: string;
  createdAt: number;
}

export interface RelayDisconnectedEvent {
  kind: "disconnected";
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
  giftName?: string | null;
  giftCount?: number;
  diamondValue?: number | null;
  targetUsername?: string | null;
  targetNickname?: string | null;
  username?: string | null;
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
  summary: string;
  createdAt: number;
}

export interface GiftLogItem {
  id: string;
  streamId: string;
  senderUsername: string | null;
  giftName: string | null;
  giftCount: number;
  diamondValue: number | null;
  targetUsername: string | null;
  targetNickname: string | null;
  /** none = logged only; pending/done = alert queue state */
  alertStatus: "none" | QueueItemStatus;
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
  if (typeof diamondValue !== "number") return 0;
  const count = giftCount && giftCount > 0 ? giftCount : 1;
  return diamondValue * count;
}

export function formatGiftTarget(
  username: string | null | undefined,
  nickname?: string | null,
): string | null {
  const handle = username?.trim() || null;
  const nick = nickname?.trim() || null;
  if (!handle && !nick) return null;
  if (handle && nick && nick.toLowerCase() !== handle.toLowerCase()) {
    return `${nick} @${handle}`;
  }
  return handle ? `@${handle}` : nick;
}

export function formatGiftAlertBody(input: {
  senderUsername: string | null;
  giftName: string | null;
  giftCount: number;
  diamondValue?: number | null;
  targetUsername: string | null;
  targetNickname?: string | null;
}): string {
  const sender = input.senderUsername ?? "someone";
  const gift = input.giftName ?? "gift";
  const to = formatGiftTarget(input.targetUsername, input.targetNickname);
  const toPart = to ? ` to ${to}` : "";
  const spend = giftDiamondSpend(input.diamondValue, input.giftCount);
  const valuePart =
    typeof input.diamondValue === "number" ? ` ${spend}◆` : ` ×${input.giftCount}`;
  return `@${sender} sent ${gift}${valuePart}${toPart}`;
}
