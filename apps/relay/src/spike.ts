/**
 * Step 1 spike: connect to a public TikTok LIVE and log raw chat/gift events.
 *
 * Guest attribution note:
 * Proto v3 `WebcastGiftMessage` includes `toUser`. In practice this often points
 * at the room host rather than a specific multi-guest box slot. Log full gift
 * payloads from a real multi-guest stream before promising per-guest targeting
 * in the UI. The queue UI intentionally omits target guest for v1.
 *
 * Usage:
 *   EULER_API_KEY=... SPIKE_USERNAME=some_live_user pnpm --filter @tiktok-mod/relay spike
 */
import { loadRepoEnv } from './load-env.js';
import { randomUUID } from 'node:crypto';
import {
  ControlEvent,
  TikTokLiveConnection,
  WebcastEvent,
} from 'tiktok-live-connector';
import type { ChatEventLike, GiftEventLike } from './normalize.js';

loadRepoEnv();

const apiKey = process.env.EULER_API_KEY;
const username = process.env.SPIKE_USERNAME;

if (!apiKey) {
  console.error(
    'Missing EULER_API_KEY env var (get a free key at https://www.eulerstream.com)',
  );
  process.exit(1);
}
if (!username) {
  console.error(
    'Missing SPIKE_USERNAME env var (TikTok uniqueId of a public live stream)',
  );
  process.exit(1);
}

const connection = new TikTokLiveConnection(username, {
  signApiKey: apiKey,
  enableExtendedGiftInfo: false,
  processInitialData: false,
});

connection.on(ControlEvent.CONNECTED, (state) => {
  console.log('[spike] connected', {
    roomId: state.roomId,
    uniqueId: username,
  });
});

connection.on(ControlEvent.DISCONNECTED, () => {
  console.log('[spike] disconnected');
});

connection.on(ControlEvent.ERROR, (err) => {
  console.error('[spike] error', err);
});

connection.on(WebcastEvent.CHAT, (data) => {
  const chat = data as ChatEventLike;
  console.log('[spike][chat]', {
    eventId: randomUUID(),
    username: chat.user?.uniqueId ?? chat.user?.displayId ?? null,
    nickname: chat.user?.nickname ?? null,
    comment: chat.comment ?? chat.content ?? '',
  });
});

connection.on(WebcastEvent.GIFT, (data) => {
  const gift = data as GiftEventLike;
  console.log('[spike][gift]', {
    eventId: randomUUID(),
    sender: gift.user?.uniqueId ?? gift.user?.displayId ?? null,
    giftId: gift.giftId,
    giftName: gift.gift?.name ?? gift.giftDetails?.giftName ?? null,
    giftType: gift.gift?.type ?? gift.giftDetails?.giftType ?? null,
    diamondCount:
      gift.gift?.diamondCount ?? gift.giftDetails?.diamondCount ?? null,
    repeatCount: gift.repeatCount,
    repeatEnd: gift.repeatEnd,
    toUser: gift.toUser?.uniqueId ?? gift.toUser?.displayId ?? null,
    toUserNickname: gift.toUser?.nickname ?? null,
    toMemberId: gift.toMemberId ?? null,
    toMemberNickname: gift.toMemberNickname ?? null,
    rawKeys: Object.keys(gift as object),
    raw: gift,
  });
});

try {
  console.log(`[spike] connecting to @${username}…`);
  await connection.connect();
  console.log('[spike] connect() resolved');
} catch (err) {
  console.error('[spike] connect failed', err);
  process.exit(1);
}
