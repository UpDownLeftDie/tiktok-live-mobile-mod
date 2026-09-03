import {
  dedupeGiftCatalogByName,
  type GiftCatalogItem,
} from '@tiktok-mod/shared';

const ANTIOPS_URL =
  'https://raw.githubusercontent.com/antiops/tiktok-trending-data/main/live-gift-details.json';

/** TikTok panel / in-app gifts (excludes historical dump rows). */
const LIVE_SOURCE = 1;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`gift catalog fetch failed ${res.status}: ${url}`);
  }
  return res.json();
}

/**
 * Live TikTok gift panel catalog from antiops (source=1 only).
 * Deduped by gift name — TikTok reuses labels across multiple gift IDs.
 */
export async function fetchRemoteGiftCatalog(): Promise<GiftCatalogItem[]> {
  const raw = await fetchJson(ANTIOPS_URL);
  if (!Array.isArray(raw)) {
    throw new Error('remote gift catalog is not an array');
  }

  const gifts: GiftCatalogItem[] = [];
  for (const item of raw) {
    const row = asRecord(item);
    if (!row) continue;
    if (num(row.source) !== LIVE_SOURCE) continue;
    const name = str(row.name);
    if (!name) continue;
    gifts.push({
      id: num(row.id),
      name,
      diamondValue: num(row.diamond_count) ?? num(row.diamondCount),
    });
  }

  const deduped = dedupeGiftCatalogByName(gifts);
  if (deduped.length === 0) {
    throw new Error('remote gift catalog returned no live gifts');
  }
  return deduped;
}
