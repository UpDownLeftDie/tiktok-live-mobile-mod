import type {
  ChatUserSignals,
  RelayChatEvent,
  RelayGiftEvent,
  RelayRoomEvent,
  RoomEventType,
} from "@tiktok-mod/shared";
import { randomUUID } from "node:crypto";

/** Runtime gift shape from tiktok-live-connector (proto v3 + optional legacy aliases). */
export type GiftEventLike = {
  giftId?: string | number;
  repeatCount?: number;
  repeatEnd?: number | boolean;
  user?: { uniqueId?: string; displayId?: string; nickname?: string };
  toUser?: { uniqueId?: string; displayId?: string; nickname?: string };
  /** Guest-box recipient when the gift is aimed at a co-host / linked member. */
  toMemberId?: string;
  toMemberNickname?: string;
  gift?: { name?: string; diamondCount?: number; type?: number };
  giftDetails?: { giftName?: string; diamondCount?: number; giftType?: number };
  extendedGiftInfo?: { name?: string; diamond_count?: number };
};

type ImageLike = { urlList?: string[]; url?: string };

type BadgeLike = {
  display?: boolean;
  text?: { key?: string; defaultPattern?: string; pieces?: unknown[] };
  str?: { key?: string; defaultPattern?: string };
  combine?: { text?: { key?: string; defaultPattern?: string } };
};

type UserLike = {
  uniqueId?: string;
  displayId?: string;
  nickname?: string;
  followInfo?: {
    followingCount?: string | number;
    followerCount?: string | number;
    followStatus?: string | number;
  };
  payGrade?: {
    name?: string;
    level?: number;
    score?: string | number;
    gradeDescribe?: string;
  };
  fansClub?: {
    data?: {
      clubName?: string;
      level?: number;
    };
  };
  fansClubInfo?: {
    fansClubName?: string;
    fansLevel?: string | number;
  };
  subscribeInfo?: {
    isSubscribe?: boolean;
    isSubscribedToAnchor?: boolean;
  };
  isSubscribe?: boolean;
  isFollower?: boolean;
  badgeList?: BadgeLike[];
  medal?: ImageLike;
  userAttr?: {
    isMuted?: boolean;
    isAdmin?: boolean;
    isSuperAdmin?: boolean;
  };
  userIdentity?: {
    isGiftGiverOfAnchor?: boolean;
    isSubscriberOfAnchor?: boolean;
    isMutualFollowingWithAnchor?: boolean;
    isFollowerOfAnchor?: boolean;
    isModeratorOfAnchor?: boolean;
    isAnchor?: boolean;
  };
};

export type ChatEventLike = {
  comment?: string;
  content?: string;
  user?: UserLike;
  userIdentity?: UserLike["userIdentity"];
  msgFilter?: {
    isGifter?: boolean;
    isSubscribedToAnchor?: boolean;
  };
};

export type RoomEventLike = {
  user?: UserLike;
  totalLikeCount?: number | string;
  likeCount?: number | string;
  memberCount?: number | string;
};

function usernameOf(user?: UserLike): string | null {
  return user?.uniqueId || user?.displayId || null;
}

function emptyToNull(value?: string | null): string | null {
  return value?.trim() || null;
}

function resolveGiftTarget(data: GiftEventLike): {
  username: string | null;
  nickname: string | null;
} {
  const memberNick = emptyToNull(data.toMemberNickname);
  if (memberNick) {
    return { username: null, nickname: memberNick };
  }
  return {
    username: usernameOf(data.toUser),
    nickname: emptyToNull(data.toUser?.nickname),
  };
}

function asNumber(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function badgeLabel(badge: BadgeLike): string | null {
  if (badge.display === false) return null;
  const raw =
    badge.text?.defaultPattern ||
    badge.str?.defaultPattern ||
    badge.combine?.text?.defaultPattern ||
    badge.text?.key ||
    badge.str?.key ||
    null;
  if (!raw) return null;
  let cleaned = raw;
  for (;;) {
    const next = cleaned.replace(/\{[^{}]*\}/g, '');
    if (next === cleaned) break;
    cleaned = next;
  }
  cleaned = cleaned.trim();
  return cleaned || null;
}

export function extractChatUserSignals(
  data: ChatEventLike,
): ChatUserSignals | null {
  const user = data.user;
  if (!user) return null;

  const identity = data.userIdentity ?? user.userIdentity;
  const fansFromMember = user.fansClub?.data;
  const fansFromInfo = user.fansClubInfo;
  const fansClubName =
    fansFromMember?.clubName || fansFromInfo?.fansClubName || null;
  const fansClubLevel =
    asNumber(fansFromMember?.level) ?? asNumber(fansFromInfo?.fansLevel);

  const pay = user.payGrade;
  const isSubscriber = Boolean(
    identity?.isSubscriberOfAnchor ||
      data.msgFilter?.isSubscribedToAnchor ||
      user.subscribeInfo?.isSubscribedToAnchor ||
      user.subscribeInfo?.isSubscribe ||
      user.isSubscribe,
  );

  const labels = (user.badgeList ?? [])
    .map(badgeLabel)
    .filter((x): x is string => Boolean(x))
    .slice(0, 4);

  return {
    nickname: user.nickname || null,
    isSubscriber,
    isFollower: Boolean(
      identity?.isFollowerOfAnchor ||
        identity?.isMutualFollowingWithAnchor ||
        user.isFollower,
    ),
    isModerator: Boolean(
      identity?.isModeratorOfAnchor ||
        user.userAttr?.isAdmin ||
        user.userAttr?.isSuperAdmin,
    ),
    isGiftGiver: Boolean(
      identity?.isGiftGiverOfAnchor || data.msgFilter?.isGifter,
    ),
    fansClubName,
    fansClubLevel,
    payGradeName: pay?.name || pay?.gradeDescribe || null,
    payGradeLevel: asNumber(pay?.level),
    payScore: asNumber(pay?.score),
    followerCount: asNumber(user.followInfo?.followerCount),
    badgeLabels: labels,
  };
}

export function normalizeChat(
  streamId: string,
  data: ChatEventLike,
): RelayChatEvent {
  return {
    kind: "chat",
    streamId,
    eventId: randomUUID(),
    username: usernameOf(data.user),
    comment: data.comment ?? data.content ?? "",
    userSignals: extractChatUserSignals(data),
    createdAt: Date.now(),
  };
}

export function shouldForwardGift(data: GiftEventLike): boolean {
  const giftType = data.gift?.type ?? data.giftDetails?.giftType;
  const repeatEnd = data.repeatEnd;
  const ended = repeatEnd === true || repeatEnd === 1;
  return giftType !== 1 || ended;
}

function parseGiftId(giftIdRaw: string | number | undefined): number | null {
  if (typeof giftIdRaw === "number") {
    return giftIdRaw;
  }
  if (!giftIdRaw) {
    return null;
  }
  const n = Number(giftIdRaw);
  return Number.isFinite(n) ? n : null;
}

export function normalizeGift(
  streamId: string,
  data: GiftEventLike,
): RelayGiftEvent {
  const giftName =
    data.gift?.name ??
    data.giftDetails?.giftName ??
    data.extendedGiftInfo?.name ??
    null;
  const diamondValue =
    data.gift?.diamondCount ??
    data.giftDetails?.diamondCount ??
    data.extendedGiftInfo?.diamond_count ??
    null;

  const target = resolveGiftTarget(data);

  return {
    kind: "gift",
    streamId,
    eventId: randomUUID(),
    senderUsername: usernameOf(data.user),
    senderNickname: emptyToNull(data.user?.nickname),
    giftName,
    giftId: parseGiftId(data.giftId),
    giftCount: Number(data.repeatCount) || 1,
    diamondValue,
    targetUsername: target.username,
    targetNickname: target.nickname,
    createdAt: Date.now(),
  };
}

export function normalizeRoomEvent(
  streamId: string,
  type: RoomEventType,
  data: RoomEventLike,
  summary: string,
): RelayRoomEvent {
  return {
    kind: "room",
    streamId,
    eventId: randomUUID(),
    type,
    username: usernameOf(data.user),
    nickname: emptyToNull(data.user?.nickname),
    summary,
    createdAt: Date.now(),
  };
}
