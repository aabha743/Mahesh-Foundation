/** Free units of a device at a center (GET /api/v1/stock: available devices minus other requests' holds). */
export type StockRow = { sku_id: string; center_id: string; available_count: number };

/** Centers where a device has a free unit, most units first. */
export function centersWithStock(skuId: string, stock: StockRow[]): string[] {
  return stock
    .filter((row) => row.sku_id === skuId && row.available_count > 0)
    .sort((a, b) => b.available_count - a.available_count)
    .map((row) => row.center_id);
}

/**
 * The pickup center to preselect for a device being added to a request:
 * the only center that has it; otherwise a center the other chosen devices already use (one trip, the most
 * used first); otherwise the area the person filtered by; otherwise the center with the most units.
 */
export function defaultPickupCenter(
  skuId: string,
  stock: StockRow[],
  otherChoices: string[],
  areaCenterId: string | null,
): string | null {
  const options = centersWithStock(skuId, stock);
  if (options.length <= 1) return options[0] ?? null;
  const uses = new Map<string, number>();
  otherChoices.forEach((centerId) => uses.set(centerId, (uses.get(centerId) ?? 0) + 1));
  const shared = options
    .filter((centerId) => uses.has(centerId))
    .sort((a, b) => (uses.get(b) ?? 0) - (uses.get(a) ?? 0));
  if (shared.length) return shared[0]!;
  if (areaCenterId && options.includes(areaCenterId)) return areaCenterId;
  return options[0]!;
}
