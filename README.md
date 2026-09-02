# TTMM - TikTok Live Mobile Mod

Phone-first PWA that watches TikTok LIVE public chat/gift events and pushes alerts to a mod’s phone. It does **not** automate TikTok (no mute/kick/guest moves/chat send) — there is no public API for that.

Architecture:

1. **Relay** (`apps/relay`) — Node Docker container running [`tiktok-live-connector`](https://github.com/zerodytrash/TikTok-Live-Connector). Holds the TikTok Webcast WebSocket. Portable: run it on a VPS, homelab, or Fly.io.
2. **Cloudflare Worker + Durable Objects** (`apps/worker`) — session state, alert queue (SQLite), Web Push, and the PWA UI. Free on Cloudflare’s Workers free plan.
3. **Euler Stream** — free signing key required by the connector for the Webcast handshake ([eulerstream.com](https://www.eulerstream.com)).

```
PWA ──HTTP──▶ Worker ──▶ StreamSession DO (queue/rules) + Registry DO (checked-in list, push subs)
                ▲
Relay ──POST events / poll checked-in──┘
  │
  └── tiktok-live-connector ──▶ TikTok Webcast (signed via Euler)
```

## Prerequisites

- Node 24+
- [pnpm](https://pnpm.io) 11+
- Cloudflare account (Workers free plan)
- Euler Stream API key (free community tier)
- Somewhere to run the relay container continuously during streams

## Quick start (local)

```bash
pnpm install

# 1) Optional: spike against a public live username (validates connector + gift payloads)
cp .env.example .env
# set EULER_API_KEY and SPIKE_USERNAME
pnpm dev:spike

# 2) Worker secrets for local wrangler
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
# Generate VAPID keys:
npx @pushforge/builder vapid
# Put VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (full JWK JSON), VAPID_SUBJECT into .dev.vars
# Also set RELAY_SECRET and optional MOD_PASSCODE

# 3) Build PWA + run Worker locally
pnpm --filter @tiktok-mod/worker build
pnpm --filter @tiktok-mod/worker dev
# → http://127.0.0.1:8787

# 4) Run the relay against the local Worker
export EULER_API_KEY=...
export WORKER_URL=http://127.0.0.1:8787
export RELAY_SECRET=dev-relay-secret-change-me   # must match .dev.vars
pnpm dev:relay
```

In the PWA: add a TikTok username → Settings → enable push → Check in. Gift/chat alerts land in the Queue tab and as Android Chrome notifications with a **Done** action.

## Deploy Worker (Cloudflare)

```bash
cd apps/worker
pnpm build
npx wrangler secret put RELAY_SECRET
npx wrangler secret put MOD_PASSCODE          # optional but recommended
npx wrangler secret put VAPID_PRIVATE_KEY     # JWK JSON from pushforge vapid
npx wrangler secret put VAPID_SUBJECT         # e.g. mailto:you@example.com
# Set VAPID_PUBLIC_KEY as a plain var (safe to expose):
npx wrangler secret put VAPID_PUBLIC_KEY      # or [vars] in wrangler.toml
pnpm deploy
```

Note the Worker URL (e.g. `https://tiktok-live-mod.<account>.workers.dev`).

## Deploy Relay (Docker)

Build from the **repo root** (workspace context):

```bash
docker build -f apps/relay/Dockerfile -t tiktok-mod-relay .
docker run --rm \
  -e EULER_API_KEY=... \
  -e WORKER_URL=https://your-worker.workers.dev \
  -e RELAY_SECRET=... \
  -e POLL_INTERVAL_MS=5000 \
  tiktok-mod-relay
```

### Hosting options (honest pricing)

| Option | Cost | Notes |
| -------- | ------ | -------- |
| Homelab / always-on PC | $0 | |
| Small VPS | ~$2–5/mo | Most reliable cheap option for most people |
| Fly.io pay-as-you-go | ~$2–5/mo realistic | See `apps/relay/fly.toml`. |
| Render free tier | ❌ Don’t | Sleeps after ~15m idle; bad for a long-lived TikTok WS |

## Gift guest attribution

TikTok Webcast gift events include a `toUser` field, but it typically refers to the room/host rather than a specific multi-guest box slot. The spike script (`pnpm dev:spike`) dumps raw gift payloads so you can verify against a real multi-guest stream. The v1 queue UI does **not** show a “target guest” field.

## Alert rules (v1)

- Gift ≥ configured diamond threshold (default 100), or named gift allowlist
- Case-insensitive chat keyword substrings

Out of scope: guest-box automation, sending chat, muting/kicking, multi-tenant auth, past-events stats UI.

## Monorepo layout

```
apps/relay/       Node relay + Dockerfile + fly.toml example
apps/worker/      Cloudflare Worker, Durable Objects, Vite React PWA
packages/shared/  Shared TypeScript types
tiktok-mod-tool-spec.md
```

## Scripts

| Script | What |
| -------- | ------ |
| `pnpm dev:spike` | Log raw chat/gift from one live username |
| `pnpm dev:relay` | Run production relay locally |
| `pnpm dev:worker` | Build client + `wrangler dev` |
| `pnpm build` | Build all packages |
| `pnpm lint` | ESLint (incl. sonarjs) |
| `pnpm typecheck` | TypeScript across workspaces |

## Cost notes

- Cloudflare Workers free plan: Durable Objects + SQLite storage included at this scale
- Web Push via VAPID: free
- Euler Stream free community tier: 2,500 REST signing requests/day (not per chat message)
- Relay hosting: $0–5/mo depending on where you run the container
