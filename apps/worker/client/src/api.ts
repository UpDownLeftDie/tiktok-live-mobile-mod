import type {
  ChatHighlightConfig,
  ConnectionStatus,
  GiftCatalogItem,
  GlobalSettings,
  LiveFeed,
  StreamConfig,
} from '@tiktok-mod/shared';

export type PublicConfig = {
  vapidPublicKey: string | null;
  passcodeRequired: boolean;
};

const PASSCODE_KEY = 'mod_passcode';
const CLIENT_ID_KEY = 'mod_client_id';
const LEFT_STREAMS_KEY = 'mod_left_streams';

export function getPasscode(): string {
  return localStorage.getItem(PASSCODE_KEY) ?? '';
}

export function setPasscode(value: string): void {
  localStorage.setItem(PASSCODE_KEY, value);
  void syncPasscodeToCache(value);
}

async function syncPasscodeToCache(value: string): Promise<void> {
  try {
    const cache = await caches.open('mod-auth');
    await cache.put('/passcode', new Response(value));
  } catch {
    // ignore
  }
}

export function authHeaders(): HeadersInit {
  const passcode = getPasscode();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Mod-Client-Id': getClientId(),
  };
  if (passcode) {
    headers.Authorization = `Bearer ${passcode}`;
  }
  return headers;
}

function requestHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(authHeaders());
  if (!extra) return headers;
  new Headers(extra).forEach((value, key) => {
    headers.set(key, value);
  });
  return headers;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: requestHeaders(init?.headers),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export function fetchPublicConfig(): Promise<PublicConfig> {
  return fetch('/api/public-config').then(
    (r) => r.json() as Promise<PublicConfig>,
  );
}

/** Validates the stored passcode without touching Durable Object storage. */
export function checkPasscode(): Promise<{ ok: true }> {
  return api('/api/auth-check');
}

export function isUnauthorized(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('401:');
}

export function isQuotaExceeded(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes('quota_exceeded') ||
    /Exceeded allowed rows/i.test(err.message)
  );
}

export function friendlyApiError(err: unknown): string {
  if (isUnauthorized(err)) return 'Incorrect passcode.';
  if (isQuotaExceeded(err)) {
    return 'Daily Durable Objects quota is exhausted. The app will work again after 00:00 UTC.';
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function listStreams(): Promise<{
  streams: Array<{
    streamId: string;
    addedAt: number;
    isCheckedIn: boolean;
    watcherCount: number;
    youAreWatching: boolean;
  }>;
}> {
  return api('/api/streams');
}

export function addStream(streamId: string): Promise<{ streamId: string }> {
  return api('/api/streams', {
    method: 'POST',
    body: JSON.stringify({ streamId }),
  });
}

export function removeStream(streamId: string): Promise<unknown> {
  return api(`/api/streams/${encodeURIComponent(streamId)}`, {
    method: 'DELETE',
  });
}

export function checkIn(streamId: string): Promise<unknown> {
  markStreamJoined(streamId);
  return api(`/api/streams/${encodeURIComponent(streamId)}/check-in`, {
    method: 'POST',
    body: JSON.stringify({ clientId: getClientId() }),
  });
}

export function checkOut(
  streamId: string,
  opts?: { force?: boolean },
): Promise<unknown> {
  markStreamLeft(streamId);
  return api(`/api/streams/${encodeURIComponent(streamId)}/check-out`, {
    method: 'POST',
    body: JSON.stringify({
      clientId: getClientId(),
      force: opts?.force === true,
    }),
  });
}

export function pingPresence(streamIds: string[]): Promise<unknown> {
  const left = getLeftStreams();
  const wanted = streamIds.filter((id) => id && !left.has(id));
  return api('/api/presence', {
    method: 'POST',
    body: JSON.stringify({ clientId: getClientId(), streamIds: wanted }),
  });
}

export function getClientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

function getLeftStreams(): Set<string> {
  try {
    const raw = localStorage.getItem(LEFT_STREAMS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

function markStreamLeft(streamId: string): void {
  const next = getLeftStreams();
  next.add(streamId);
  localStorage.setItem(LEFT_STREAMS_KEY, JSON.stringify([...next]));
}

function markStreamJoined(streamId: string): void {
  const next = getLeftStreams();
  next.delete(streamId);
  localStorage.setItem(LEFT_STREAMS_KEY, JSON.stringify([...next]));
}

export function getLiveFeed(
  streamId: string,
  since?: number | null,
): Promise<LiveFeed> {
  const query = since == null ? '' : `?since=${since}`;
  return api(`/api/streams/${encodeURIComponent(streamId)}/live${query}`);
}

export function markDone(streamId: string, itemId: string): Promise<unknown> {
  return api(
    `/api/streams/${encodeURIComponent(streamId)}/queue/${encodeURIComponent(itemId)}`,
    { method: 'PATCH' },
  );
}

export function markGiftDone(
  streamId: string,
  giftId: string,
): Promise<unknown> {
  return setGiftStatus(streamId, giftId, 'done');
}

export function markGiftPending(
  streamId: string,
  giftId: string,
): Promise<unknown> {
  return setGiftStatus(streamId, giftId, 'pending');
}

export function markGiftsDone(
  streamId: string,
  giftIds: string[],
): Promise<unknown> {
  return setGiftsStatus(streamId, giftIds, 'done');
}

export function markGiftsPending(
  streamId: string,
  giftIds: string[],
): Promise<unknown> {
  return setGiftsStatus(streamId, giftIds, 'pending');
}

function setGiftsStatus(
  streamId: string,
  giftIds: string[],
  status: 'done' | 'pending',
): Promise<unknown> {
  return api(`/api/streams/${encodeURIComponent(streamId)}/gifts`, {
    method: 'PATCH',
    body: JSON.stringify({ status, ids: giftIds }),
  });
}

function setGiftStatus(
  streamId: string,
  giftId: string,
  status: 'done' | 'pending',
): Promise<unknown> {
  return api(
    `/api/streams/${encodeURIComponent(streamId)}/gifts/${encodeURIComponent(giftId)}`,
    { method: 'PATCH', body: JSON.stringify({ status }) },
  );
}

export function getConfig(streamId: string): Promise<StreamConfig> {
  return api(`/api/streams/${encodeURIComponent(streamId)}/config`);
}

export function putConfig(
  streamId: string,
  body: {
    giftAlertRules?: StreamConfig['giftAlertRules'] | null;
    chatKeywordFlags?: string[] | null;
    chatHighlights?: ChatHighlightConfig | Partial<ChatHighlightConfig> | null;
    clearOverrides?: boolean;
  },
): Promise<StreamConfig> {
  return api(`/api/streams/${encodeURIComponent(streamId)}/config`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export function getGlobalSettings(): Promise<GlobalSettings> {
  return api('/api/global-settings');
}

export function putGlobalSettings(
  body: Partial<GlobalSettings>,
): Promise<GlobalSettings> {
  return api('/api/global-settings', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export function getGiftCatalog(): Promise<{
  gifts: GiftCatalogItem[];
  updatedAt: number | null;
}> {
  return api('/api/gift-catalog');
}

export function subscribePush(
  subscription: PushSubscriptionJSON,
): Promise<unknown> {
  return api('/api/subscribe', {
    method: 'POST',
    body: JSON.stringify(subscription),
  });
}

export function testPush(): Promise<unknown> {
  return api('/api/test-push', { method: 'POST' });
}

export type QuotaMetric = {
  key: string;
  label: string;
  used: number;
  limit: number;
};

export type QuotaSnapshot = {
  source: 'cloudflare' | 'local';
  date: string;
  resetAt: string;
  metrics: QuotaMetric[];
  objects: Array<{
    name: string;
    rowsRead: number;
    rowsWritten: number;
  }>;
};

export function fetchQuota(): Promise<QuotaSnapshot> {
  return api('/api/quota');
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replaceAll('-', '+')
    .replaceAll('_', '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw.codePointAt(i) ?? 0;
  }
  return out;
}

export function statusLabel(status: ConnectionStatus): string {
  switch (status) {
    case 'live':
      return 'Live';
    case 'waiting':
      return 'Connecting';
    case 'offline':
      return 'Offline';
    case 'disconnected':
      return 'Disconnected';
    default:
      return 'Idle';
  }
}

export { DEFAULT_CHAT_HIGHLIGHTS } from '@tiktok-mod/shared';
