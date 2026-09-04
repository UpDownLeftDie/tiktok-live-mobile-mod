/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';

declare let self: ServiceWorkerGlobalScope;

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// registerType is 'autoUpdate', but the injectManifest strategy does not add
// these for us. Without them a new worker installs and waits forever, so an
// installed PWA that is never fully closed keeps serving the bundle it first
// cached — which is how a client kept polling the pre-cursor live feed across
// two deploys.
self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});

interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  streamId?: string;
  queueItemId?: string;
  actions?: Array<{ action: string; title: string }>;
}

self.addEventListener('push', (event: PushEvent) => {
  let data: PushPayload = {
    title: 'TTMM',
    body: 'New alert',
  };
  try {
    if (event.data) {
      data = event.data.json() as PushPayload;
    }
  } catch {
    data.body = event.data?.text() ?? data.body;
  }

  const actions = data.actions ?? [{ action: 'done', title: 'Done' }];

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag ?? `alert-${Date.now()}`,
      // renotify is supported on Chromium; cast for TS NotificationOptions
      ...({ renotify: true } as NotificationOptions),
      data: {
        streamId: data.streamId,
        queueItemId: data.queueItemId,
      },
      actions: data.queueItemId
        ? actions.map((a) => ({ action: a.action, title: a.title }))
        : [],
    } as NotificationOptions),
  );
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  const action = event.action;
  const data = (event.notification.data ?? {}) as {
    streamId?: string;
    queueItemId?: string;
  };

  event.notification.close();

  if (action === 'done' && data.streamId && data.queueItemId) {
    event.waitUntil(markDone(data.streamId, data.queueItemId));
    return;
  }

  const targetUrl = data.streamId
    ? `/?stream=${encodeURIComponent(data.streamId)}`
    : '/';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ('focus' in client) {
            void client.navigate(targetUrl);
            return client.focus();
          }
        }
        return self.clients.openWindow(targetUrl);
      }),
  );
});

async function markDone(streamId: string, queueItemId: string): Promise<void> {
  const passcode = await getStoredPasscode();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (passcode) {
    headers.Authorization = `Bearer ${passcode}`;
  }
  await fetch(
    `/api/streams/${encodeURIComponent(streamId)}/queue/${encodeURIComponent(queueItemId)}`,
    { method: 'PATCH', headers },
  );
}

async function getStoredPasscode(): Promise<string | null> {
  try {
    const cache = await caches.open('mod-auth');
    const res = await cache.match('/passcode');
    if (res) {
      const text = await res.text();
      return text || null;
    }
  } catch {
    // ignore
  }
  return null;
}
