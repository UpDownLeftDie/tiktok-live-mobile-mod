# Guest / box gift attribution

Verified against `tiktok-live-connector` proto v3 types (`WebcastGiftMessage`):

- Field `toUser` exists on gift events.
- In practice this usually identifies the room host (or is empty), **not** a reliable
  multi-guest box slot. Confirm with `pnpm dev:spike` on a real multi-guest live
  before building UI that promises per-guest targeting.

The queue UI intentionally omits target guest in v1; `gift_log.target_username`
still stores best-effort `toUser.displayId` for later analysis.
