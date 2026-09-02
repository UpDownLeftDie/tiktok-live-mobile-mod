import { loadRepoEnv } from "./load-env.js";
import { StreamWatcher } from "./stream-watcher.js";
import { WorkerClient } from "./worker-client.js";

loadRepoEnv();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const eulerApiKey = requireEnv("EULER_API_KEY");
const workerUrl = requireEnv("WORKER_URL").replace(/\/$/, "");
const relaySecret = requireEnv("RELAY_SECRET");
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? "5000");

const worker = new WorkerClient(workerUrl, relaySecret);
const watchers = new Map<string, StreamWatcher>();

async function syncWatchers(): Promise<void> {
  const streams = await worker.getCheckedIn();
  const wanted = new Set(streams.map((s) => s.streamId));

  for (const [streamId, watcher] of watchers) {
    if (!wanted.has(streamId)) {
      console.log(`[relay] check-out detected, stopping @${streamId}`);
      await watcher.stop();
      watchers.delete(streamId);
    }
  }

  for (const stream of streams) {
    if (watchers.has(stream.streamId)) {
      continue;
    }
    console.log(`[relay] check-in detected, watching @${stream.streamId}`);
    const watcher = new StreamWatcher(stream.streamId, eulerApiKey, worker);
    watchers.set(stream.streamId, watcher);
    // Retries offline/unavailable internally — do not tear down on first failure.
    watcher.start();
  }
}

process.on("SIGINT", () => {
  console.log("[relay] SIGINT, shutting down…");
  void Promise.all([...watchers.values()].map((w) => w.stop())).then(() =>
    process.exit(0),
  );
});

console.log(`[relay] starting; worker=${workerUrl} poll=${pollIntervalMs}ms`);
for (;;) {
  try {
    await syncWatchers();
  } catch (err) {
    console.error("[relay] poll failed", err);
  }
  await new Promise((r) => setTimeout(r, pollIntervalMs));
}
