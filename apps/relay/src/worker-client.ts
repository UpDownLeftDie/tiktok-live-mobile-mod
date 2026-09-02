import type { CheckedInStream, RelayEvent } from '@tiktok-mod/shared';

export class WorkerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly relaySecret: string,
  ) {}

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.relaySecret}`,
    };
    if (json) {
      h['Content-Type'] = 'application/json';
    }
    return h;
  }

  async getCheckedIn(): Promise<CheckedInStream[]> {
    const res = await fetch(`${this.baseUrl}/api/checked-in`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`checked-in failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { streams: CheckedInStream[] };
    return body.streams;
  }

  async postEvent(streamId: string, event: RelayEvent): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/streams/${encodeURIComponent(streamId)}/events`,
      {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify(event),
      },
    );
    if (!res.ok) {
      throw new Error(
        `post event failed (${streamId}/${event.kind}): ${res.status} ${await res.text()}`,
      );
    }
  }
}
