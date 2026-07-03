/**
 * Detects when an approved lease still has pending lines that cannot be fully
 * covered by available inventory at the issuing center (needs Transfer asset
 * or pickup-from-source planning).
 */

export type LeaseItemForStock = {
  sku_id: string;
  quantity_requested: number;
  asset_id: string | null | undefined;
};

export type LeaseForLocalStock = {
  status: string;
  items?: LeaseItemForStock[];
  skus: string[];
};

export type AssetForLocalStock = {
  sku_id: string;
  center_id: string | null;
  status: string;
};

function availableCountsAtCenter(centerId: string, assets: AssetForLocalStock[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of assets) {
    if (a.center_id !== centerId || a.status !== "available") continue;
    m.set(a.sku_id, (m.get(a.sku_id) ?? 0) + 1);
  }
  return m;
}

/**
 * True if the lease is approved and at least one pending line cannot be satisfied
 * from `available` units at `centerId` (same heuristic as issue-context local counts).
 */
export function approvedLeaseNeedsOffCenterFulfillmentPlan(
  lease: LeaseForLocalStock,
  centerId: string,
  assets: AssetForLocalStock[],
  skuNameToId: Record<string, string>,
): boolean {
  if (lease.status !== "approved") return false;
  const pool = availableCountsAtCenter(centerId, assets);

  if ((lease.items ?? []).length > 0) {
    const pending = (lease.items ?? []).filter((i) => !i.asset_id);
    if (pending.length === 0) return false;
    for (const line of pending) {
      const qty = Math.max(1, line.quantity_requested);
      const left = pool.get(line.sku_id) ?? 0;
      if (left < qty) return true;
      pool.set(line.sku_id, left - qty);
    }
    return false;
  }

  if (!lease.skus?.length) return false;
  for (const name of lease.skus) {
    const skuId = skuNameToId[name];
    if (!skuId) return true;
    const left = pool.get(skuId) ?? 0;
    if (left < 1) return true;
    pool.set(skuId, left - 1);
  }
  return false;
}
