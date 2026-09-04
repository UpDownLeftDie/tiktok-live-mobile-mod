/**
 * Insurance against a client running a bundle older than the deployed one.
 *
 * The service worker normally handles this, but if its update cycle stalls the
 * app can poll a stale feed for hours — a full refresh every 2.5s costs roughly
 * 680 Durable Object row reads, so one stuck client is expensive. Vite hashes
 * the entry chunk per build, so comparing our own module URL against the one
 * index.html currently points at tells us directly whether we are behind.
 */

const CHECK_INTERVAL_MS = 15 * 60_000;
const SCRIPT_SRC = /<script[^>]+type="module"[^>]+src="([^"]+)"/;
const RELOAD_FLAG = 'ttmm:update-reloaded';

function ownChunk(): string | null {
  try {
    return new URL(import.meta.url).pathname.split('/').pop() ?? null;
  } catch {
    return null;
  }
}

async function deployedChunk(): Promise<string | null> {
  try {
    const res = await fetch('/index.html', { cache: 'reload' });
    if (!res.ok) return null;
    const src = SCRIPT_SRC.exec(await res.text())?.[1];
    return src ? (new URL(src, location.origin).pathname.split('/').pop() ?? null) : null;
  } catch {
    return null;
  }
}

async function checkOnce(): Promise<void> {
  const mine = ownChunk();
  if (!mine) return;
  const theirs = await deployedChunk();
  if (!theirs || theirs === mine) return;

  // Only ever act once, so a bad deploy cannot put us in a reload loop.
  if (sessionStorage.getItem(RELOAD_FLAG)) return;
  sessionStorage.setItem(RELOAD_FLAG, '1');

  const registration = await navigator.serviceWorker?.getRegistration();
  await registration?.update().catch(() => undefined);
  location.reload();
}

export function startUpdateCheck(): void {
  const run = () => void checkOnce();
  setInterval(run, CHECK_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) run();
  });
  run();
}
