import raw from "./gift-catalog.json" with { type: "json" };

export interface GiftCatalogItem {
  id: number | null;
  name: string;
  diamondValue: number | null;
}

/** One row per gift name (case-insensitive); keeps the highest diamond value. */
export function dedupeGiftCatalogByName(
  gifts: GiftCatalogItem[],
): GiftCatalogItem[] {
  const byName = new Map<string, GiftCatalogItem>();
  for (const gift of gifts) {
    const name = gift.name?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, { ...gift, name });
      continue;
    }
    const nextDiamonds = gift.diamondValue ?? -1;
    const prevDiamonds = existing.diamondValue ?? -1;
    if (nextDiamonds > prevDiamonds) {
      byName.set(key, { ...gift, name });
      continue;
    }
    if (
      nextDiamonds === prevDiamonds &&
      gift.id != null &&
      (existing.id == null || gift.id < existing.id)
    ) {
      byName.set(key, { ...gift, name });
    }
  }
  return [...byName.values()].sort((a, b) => {
    const da = b.diamondValue ?? 0;
    const db = a.diamondValue ?? 0;
    if (da !== db) return da - db;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Built-in TikTok LIVE gift catalog (live panel / source=1 snapshot).
 * Source: antiops/tiktok-trending-data live-gift-details.json
 */
export const GIFT_CATALOG: GiftCatalogItem[] = dedupeGiftCatalogByName(
  raw as GiftCatalogItem[],
);

/** Id → name from the raw catalog (before name dedupe) so seasonal renames still resolve. */
const GIFT_NAME_BY_ID = (() => {
  const byId = new Map<number, string>();
  for (const gift of raw as GiftCatalogItem[]) {
    if (gift.id == null) continue;
    const name = gift.name?.trim();
    if (!name || byId.has(gift.id)) continue;
    byId.set(gift.id, name);
  }
  return byId;
})();

/**
 * Prefer the catalog name for a TikTok gift id (stable) over the payload
 * display string, which can be a seasonal/marketing label.
 */
export function resolveCatalogGiftName(
  giftId: number | null | undefined,
  fallbackName: string | null | undefined,
): string | null {
  if (giftId != null) {
    const catalogName = GIFT_NAME_BY_ID.get(giftId);
    if (catalogName) return catalogName;
  }
  const fallback = fallbackName?.trim();
  return fallback || null;
}
