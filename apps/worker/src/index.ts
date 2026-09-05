import { requireModAuth, requireRelayAuth, registryStub, streamStub } from "./auth";
import type { Env } from "./env";
import { fetchQuotaSnapshot, quotaExceededResponse } from "./quota";

export { StreamSession } from "./stream-session";
export { Registry } from "./registry";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

async function forwardToStream(
  env: Env,
  streamId: string,
  path: string,
  request: Request,
  extraQuery = "",
): Promise<Response> {
  const stub = streamStub(env, streamId);
  const url = `https://do${path}?streamId=${encodeURIComponent(streamId)}${extraQuery}`;
  return stub.fetch(
    new Request(url, {
      method: request.method,
      headers: request.headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer(),
    }),
  );
}

function matchStreamPath(
  pathname: string,
  suffix: string,
): string | null {
  const prefix = "/api/streams/";
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const idx = rest.indexOf("/");
  if (idx === -1) {
    return suffix === "" ? decodeURIComponent(rest) : null;
  }
  const id = decodeURIComponent(rest.slice(0, idx));
  const pathSuffix = rest.slice(idx);
  return pathSuffix === suffix ? id : null;
}

async function handleRelayRoutes(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response | null> {
  if (request.method === "GET" && pathname === "/api/checked-in") {
    const denied = requireRelayAuth(request, env);
    if (denied) return denied;
    return registryStub(env).fetch(new Request("https://registry/list"));
  }

  const eventStream = matchStreamPath(pathname, "/events");
  if (eventStream && request.method === "POST") {
    const denied = requireRelayAuth(request, env);
    if (denied) return denied;
    return forwardToStream(env, eventStream, "/events", request);
  }

  if (pathname === "/api/gift-catalog" && request.method === "PUT") {
    const denied = requireRelayAuth(request, env);
    if (denied) return denied;
    return registryStub(env).fetch(
      new Request("https://registry/gift-catalog", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: await request.text(),
      }),
    );
  }

  return null;
}

async function handleStreamCollection(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response | null> {
  if (pathname !== "/api/streams") return null;

  const denied = requireModAuth(request, env);
  if (denied) return denied;

  if (request.method === "GET") {
    const clientId = request.headers.get("X-Mod-Client-Id") ?? "";
    const qs = clientId
      ? `?clientId=${encodeURIComponent(clientId)}`
      : "";
    return registryStub(env).fetch(new Request(`https://registry/streams${qs}`));
  }
  if (request.method === "POST") {
    return registryStub(env).fetch(
      new Request("https://registry/streams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await request.text(),
      }),
    );
  }
  return null;
}

async function handleQueueAndConfig(
  request: Request,
  env: Env,
  pathname: string,
  url: URL,
  denied: Response | null,
): Promise<Response | null> {
  const live = matchStreamPath(pathname, "/live");
  if (live && request.method === "GET") {
    const since = url.searchParams.get("since");
    const extra = since ? `&since=${encodeURIComponent(since)}` : "";
    return denied ?? forwardToStream(env, live, "/live", request, extra);
  }

  const queue = matchStreamPath(pathname, "/queue");
  if (queue && request.method === "GET") {
    const status = url.searchParams.get("status");
    const extra = status ? `&status=${encodeURIComponent(status)}` : "";
    return (
      denied ?? forwardToStream(env, queue, "/queue", request, extra)
    );
  }

  const giftsBulk = matchStreamPath(pathname, "/gifts");
  if (giftsBulk && request.method === "PATCH") {
    return denied ?? forwardToStream(env, giftsBulk, "/gifts", request);
  }

  const patchTarget = matchStreamPatch(pathname);
  if (patchTarget && request.method === "PATCH") {
    return (
      denied ??
      forwardToStream(
        env,
        patchTarget.streamId,
        `/${patchTarget.kind}/${encodeURIComponent(patchTarget.id)}`,
        request,
      )
    );
  }

  const config = matchStreamPath(pathname, "/config");
  if (config && (request.method === "GET" || request.method === "PUT")) {
    return denied ?? forwardToStream(env, config, "/config", request);
  }

  return null;
}

function matchStreamPatch(
  pathname: string,
): { streamId: string; kind: "queue" | "gifts"; id: string } | null {
  const match = pathname.match(
    /^\/api\/streams\/([^/]+)\/(queue|gifts)\/([^/]+)$/,
  );
  if (!match) return null;
  return {
    streamId: decodeURIComponent(match[1]!),
    kind: match[2] as "queue" | "gifts",
    id: decodeURIComponent(match[3]!),
  };
}

async function handleStreamItem(
  request: Request,
  env: Env,
  pathname: string,
  url: URL,
): Promise<Response | null> {
  const denied = requireModAuth(request, env);

  const deleteId = matchStreamPath(pathname, "");
  if (
    deleteId &&
    request.method === "DELETE" &&
    !pathname.slice("/api/streams/".length).includes("/")
  ) {
    if (denied) return denied;
    return registryStub(env).fetch(
      new Request(`https://registry/streams/${encodeURIComponent(deleteId)}`, {
        method: "DELETE",
      }),
    );
  }

  const checkIn = matchStreamPath(pathname, "/check-in");
  if (checkIn && request.method === "POST") {
    if (denied) return denied;
    return forwardToStream(env, checkIn, "/check-in", request);
  }

  const checkOut = matchStreamPath(pathname, "/check-out");
  if (checkOut && request.method === "POST") {
    if (denied) return denied;
    return forwardToStream(env, checkOut, "/check-out", request);
  }

  return handleQueueAndConfig(request, env, pathname, url, denied);
}

async function handlePresenceRoute(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response | null> {
  if (pathname !== "/api/presence" || request.method !== "POST") return null;
  const denied = requireModAuth(request, env);
  if (denied) return denied;
  return registryStub(env).fetch(
    new Request("https://registry/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
    }),
  );
}

async function handlePushRoutes(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response | null> {
  if (pathname === "/api/subscribe" && request.method === "POST") {
    const denied = requireModAuth(request, env);
    if (denied) return denied;
    return registryStub(env).fetch(
      new Request("https://registry/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await request.text(),
      }),
    );
  }

  if (pathname === "/api/test-push" && request.method === "POST") {
    const denied = requireModAuth(request, env);
    if (denied) return denied;
    return registryStub(env).fetch(
      new Request("https://registry/test-push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await request.text(),
      }),
    );
  }

  if (pathname === "/api/gift-catalog" && request.method === "GET") {
    const denied = requireModAuth(request, env);
    if (denied) return denied;
    return registryStub(env).fetch(
      new Request("https://registry/gift-catalog"),
    );
  }

  if (pathname === "/api/global-settings") {
    return handleGlobalSettings(request, env);
  }

  if (pathname === "/api/quota" && request.method === "GET") {
    const denied = requireModAuth(request, env);
    if (denied) return denied;
    return json(await fetchQuotaSnapshot(env));
  }

  return null;
}

async function handleGlobalSettings(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const denied = requireModAuth(request, env);
  if (denied) return denied;
  if (request.method === "GET") {
    return registryStub(env).fetch(
      new Request("https://registry/global-settings"),
    );
  }
  if (request.method === "PUT") {
    return registryStub(env).fetch(
      new Request("https://registry/global-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: await request.text(),
      }),
    );
  }
  return null;
}

async function handleApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const { pathname } = url;

  if (request.method === "GET" && pathname === "/api/public-config") {
    return json({
      vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
      passcodeRequired: Boolean(env.MOD_PASSCODE),
    });
  }

  if (request.method === "GET" && pathname === "/api/auth-check") {
    const denied = requireModAuth(request, env);
    if (denied) return denied;
    return json({ ok: true });
  }

  const relay = await handleRelayRoutes(request, env, pathname);
  if (relay) return relay;

  const collection = await handleStreamCollection(request, env, pathname);
  if (collection) return collection;

  const item = await handleStreamItem(request, env, pathname, url);
  if (item) return item;

  const presence = await handlePresenceRoute(request, env, pathname);
  if (presence) return presence;

  const push = await handlePushRoutes(request, env, pathname);
  if (push) return push;

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url);
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      const quota = quotaExceededResponse(err);
      if (quota) return quota;
      throw err;
    }
  },
};
