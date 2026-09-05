import type { ConnectionStatus } from '@tiktok-mod/shared';
import {
  ControlEvent,
  TikTokLiveConnection,
  WebcastEvent,
} from 'tiktok-live-connector';
import {
  normalizeChat,
  normalizeGift,
  normalizeRoomEvent,
  shouldForwardGift,
  type ChatEventLike,
  type GiftEventLike,
  type RoomEventLike,
} from './normalize.js';
import type { WorkerClient } from './worker-client.js';

const OFFLINE_RETRY_MS = Number(process.env.OFFLINE_RETRY_MS ?? '30000');

function errorSummary(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === 'object' && err && 'info' in err) {
    return String((err as { info?: unknown }).info);
  }
  return String(err);
}

export function isOfflineOrUnavailable(err: unknown): boolean {
  const message = errorSummary(err);
  return (
    /UserOffline/i.test(message) ||
    /not currently live/i.test(message) ||
    /Failed to retrieve Room ID/i.test(message) ||
    /LIVE_END/i.test(message) ||
    /room.*not found/i.test(message)
  );
}

export class StreamWatcher {
  private connection: TikTokLiveConnection | null = null;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private connectedOnce = false;
  private loggedWaiting = false;
  /** True after the first STREAM_END for the current live session (dedupe posts). */
  private streamEndPosted = false;
  /** Set by STREAM_END so the loop backs off like offline instead of reconnecting immediately. */
  private awaitOfflineBackoff = false;

  constructor(
    readonly streamId: string,
    private readonly apiKey: string,
    private readonly worker: WorkerClient,
  ) {}

  start(): void {
    if (this.loopPromise) return;
    this.stopping = false;
    this.streamEndPosted = false;
    this.awaitOfflineBackoff = false;
    this.loopPromise = this.runLoop().finally(() => {
      this.loopPromise = null;
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.reportStatus('idle', 'checked_out');
    await this.teardownConnection();
    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
    }
  }

  private async reportStatus(
    status: ConnectionStatus,
    detail?: string,
  ): Promise<void> {
    try {
      await this.worker.postEvent(this.streamId, {
        kind: 'status',
        streamId: this.streamId,
        status,
        detail,
        createdAt: Date.now(),
      });
    } catch (err) {
      console.warn(
        `[relay] status post failed @${this.streamId}: ${errorSummary(err)}`,
      );
    }
  }

  private postRoom(
    type: Parameters<typeof normalizeRoomEvent>[1],
    data: RoomEventLike,
    summary: string,
  ): void {
    const event = normalizeRoomEvent(this.streamId, type, data, summary);
    void this.worker.postEvent(this.streamId, event).catch((e: unknown) => {
      console.warn(
        `[relay] room post failed @${this.streamId}: ${errorSummary(e)}`,
      );
    });
  }

  private async runLoop(): Promise<void> {
    await this.reportStatus('waiting', 'connecting');
    while (!this.stopping) {
      try {
        await this.connectOnce();
        this.connectedOnce = true;
        this.loggedWaiting = false;
        if (!this.awaitOfflineBackoff) {
          await this.reportStatus('live');
        }
        await this.waitUntilStoppedOrDisconnected();
        if (this.stopping) break;
        if (this.awaitOfflineBackoff) {
          this.awaitOfflineBackoff = false;
          await this.reportStatus('offline', 'stream_ended');
          if (!this.loggedWaiting) {
            console.log(
              `[relay] @${this.streamId} stream ended; retrying every ${OFFLINE_RETRY_MS / 1000}s`,
            );
            this.loggedWaiting = true;
          }
          await sleep(OFFLINE_RETRY_MS);
          continue;
        }
        if (this.connectedOnce) {
          await this.reportStatus('disconnected', 'tiktok_ws_disconnected');
        }
      } catch (err) {
        await this.teardownConnection();
        if (this.stopping) break;
        await this.handleConnectFailure(err);
      }
    }
  }

  private async handleConnectFailure(err: unknown): Promise<void> {
    if (isOfflineOrUnavailable(err)) {
      await this.reportStatus('offline', errorSummary(err));
      if (!this.loggedWaiting) {
        console.log(
          `[relay] @${this.streamId} not live; retrying every ${OFFLINE_RETRY_MS / 1000}s`,
        );
        this.loggedWaiting = true;
      }
    } else {
      await this.reportStatus('waiting', errorSummary(err));
      console.warn(
        `[relay] @${this.streamId} connect failed: ${errorSummary(err)}; retrying in ${OFFLINE_RETRY_MS / 1000}s`,
      );
    }
    await sleep(OFFLINE_RETRY_MS);
  }

  private disconnectedResolver: (() => void) | null = null;

  private waitUntilStoppedOrDisconnected(): Promise<void> {
    return new Promise((resolve) => {
      this.disconnectedResolver = resolve;
      if (this.stopping || !this.connection) {
        resolve();
      }
    });
  }

  private signalDisconnected(): void {
    const resolve = this.disconnectedResolver;
    this.disconnectedResolver = null;
    resolve?.();
  }

  private async connectOnce(): Promise<void> {
    this.streamEndPosted = false;
    this.awaitOfflineBackoff = false;

    const connection = new TikTokLiveConnection(this.streamId, {
      signApiKey: this.apiKey,
      enableExtendedGiftInfo: false,
      processInitialData: false,
    });
    this.connection = connection;

    connection.on(ControlEvent.CONNECTED, (state) => {
      console.log(`[relay] connected @${this.streamId} room=${state.roomId}`);
    });

    connection.on(ControlEvent.DISCONNECTED, () => {
      console.log(`[relay] disconnected @${this.streamId}`);
      if (!this.stopping && this.connectedOnce) {
        void this.worker
          .postEvent(this.streamId, {
            kind: 'disconnected',
            streamId: this.streamId,
            reason: 'tiktok_ws_disconnected',
            createdAt: Date.now(),
          })
          .catch((err: unknown) =>
            console.warn(
              `[relay] failed to report disconnect @${this.streamId}: ${errorSummary(err)}`,
            ),
          );
      }
      this.connection = null;
      this.signalDisconnected();
    });

    connection.on(ControlEvent.ERROR, (err) => {
      if (isOfflineOrUnavailable(err)) return;
      console.warn(`[relay] @${this.streamId} error: ${errorSummary(err)}`);
    });

    connection.on(WebcastEvent.CHAT, (data) => {
      const event = normalizeChat(this.streamId, data as ChatEventLike);
      void this.worker.postEvent(this.streamId, event).catch((e: unknown) => {
        console.warn(
          `[relay] chat post failed @${this.streamId}: ${errorSummary(e)}`,
        );
      });
    });

    connection.on(WebcastEvent.GIFT, (data) => {
      const gift = data as GiftEventLike;
      if (!shouldForwardGift(gift)) return;
      const event = normalizeGift(this.streamId, gift);
      void this.worker.postEvent(this.streamId, event).catch((e: unknown) => {
        console.warn(
          `[relay] gift post failed @${this.streamId}: ${errorSummary(e)}`,
        );
      });
    });

    connection.on(WebcastEvent.FOLLOW, (data) => {
      const d = data as RoomEventLike;
      this.postRoom('follow', d, 'followed');
    });

    connection.on(WebcastEvent.SHARE, (data) => {
      const d = data as RoomEventLike;
      this.postRoom('share', d, 'shared the stream');
    });

    // Skip WebcastEvent.MEMBER — every viewer join on a busy room floods
    // Durable Object row writes for little mod value (same rationale as LIKE).
    // Skip WebcastEvent.LIKE — too noisy for the events column.

    connection.on(WebcastEvent.STREAM_END, () => {
      this.awaitOfflineBackoff = true;
      if (this.streamEndPosted) return;
      this.streamEndPosted = true;
      this.postRoom('stream_end', {}, 'Stream ended');
    });

    await connection.connect();
  }

  private async teardownConnection(): Promise<void> {
    const conn = this.connection;
    this.connection = null;
    this.signalDisconnected();
    if (!conn) return;
    try {
      await conn.disconnect();
    } catch {
      // ignore
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
