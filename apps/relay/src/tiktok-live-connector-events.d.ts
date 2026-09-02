import type { ClientEventMap } from 'tiktok-live-connector';

declare module 'tiktok-live-connector' {
  interface TikTokLiveConnection {
    on<K extends keyof ClientEventMap>(
      event: K,
      listener: ClientEventMap[K],
    ): this;
  }
}
