import { buildPushHTTPRequest } from "@pushforge/builder";
import type { PushNotificationPayload } from "@tiktok-mod/shared";
import type { Env } from "./env";

export interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function sendWebPush(
  env: Env,
  subscription: StoredSubscription,
  payload: PushNotificationPayload,
): Promise<{ ok: boolean; status: number }> {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    console.warn("VAPID secrets not configured; skipping push");
    return { ok: false, status: 0 };
  }

  let privateJWK: JsonWebKey;
  try {
    privateJWK = JSON.parse(env.VAPID_PRIVATE_KEY) as JsonWebKey;
  } catch {
    console.error("VAPID_PRIVATE_KEY must be a JSON JWK string from `npx @pushforge/builder vapid`");
    return { ok: false, status: 0 };
  }

  const { endpoint, headers, body } = await buildPushHTTPRequest({
    privateJWK,
    subscription: {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.p256dh,
        auth: subscription.auth,
      },
    },
    message: {
      payload: {
        title: payload.title,
        body: payload.body,
        tag: payload.tag,
        streamId: payload.streamId,
        queueItemId: payload.queueItemId,
        actions: payload.actions ?? [],
      },
      adminContact: env.VAPID_SUBJECT,
      options: {
        ttl: 60,
        urgency: "high",
        topic: payload.tag.slice(0, 32),
      },
    },
  });

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body,
  });

  return { ok: res.ok || res.status === 201, status: res.status };
}
