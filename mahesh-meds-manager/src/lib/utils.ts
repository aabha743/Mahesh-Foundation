import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Formats lease status from API response to user-friendly display text.
 * Maps backend API status values to consistent frontend display labels.
 */
export function formatLeaseStatus(status: string): string {
  const statusMap: Record<string, string> = {
    "closed": "Closed",
    "active": "Active", 
    "approved": "Approved",
    "pending": "Pending",
    "rejected": "Rejected",
    "expired": "Expired",
  };
  
  return statusMap[status] || status;
}

/**
 * Center label for a request card. The API only sends pickup guidance for pending and
 * approved requests, so other requests fall back to the center the requester chose.
 */
export function formatPickupCenterLabel(
  uiStatus: string,
  fulfillmentCenterNames: string[],
  preferredCenterName: string | undefined,
): string {
  if (fulfillmentCenterNames.length > 0) return fulfillmentCenterNames.join(", ");
  if (uiStatus === "Expired") return "Stock released";
  if (uiStatus === "Pending" || uiStatus === "Approved") return "Awaiting stock mapping";
  return preferredCenterName ?? "—";
}
