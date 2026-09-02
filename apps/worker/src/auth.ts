import type { Env } from "./env";

export function requireRelayAuth(request: Request, env: Env): Response | null {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!env.RELAY_SECRET || token !== env.RELAY_SECRET) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export function requireModAuth(request: Request, env: Env): Response | null {
  if (!env.MOD_PASSCODE) {
    return null;
  }
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const alt = request.headers.get("X-Mod-Passcode") ?? "";
  if (token !== env.MOD_PASSCODE && alt !== env.MOD_PASSCODE) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export function streamStub(env: Env, streamId: string): DurableObjectStub {
  const id = env.STREAM_SESSION.idFromName(streamId);
  return env.STREAM_SESSION.get(id);
}

export function registryStub(env: Env): DurableObjectStub {
  const id = env.REGISTRY.idFromName("global");
  return env.REGISTRY.get(id);
}
