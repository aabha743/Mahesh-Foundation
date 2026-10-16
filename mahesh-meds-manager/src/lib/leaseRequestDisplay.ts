/** How lease requests are shown in staff lists: status colours, which ones await a decision, pickup centers. */
import type { LeaseStatus } from "@/lib/uiTypes";

export const leaseStatusColors: Record<LeaseStatus, string> = {
  Pending: "bg-warning/10 text-warning border-warning/20",
  Approved: "bg-success/10 text-success border-success/20",
  Rejected: "bg-destructive/10 text-destructive border-destructive/20",
  Active: "bg-primary/10 text-primary border-primary/20",
  Closed: "bg-muted text-muted-foreground border-border",
  Expired: "bg-warning/10 text-warning border-warning/20",
};

/** Requests an approver still has to act on: new ones, and expired ones that can be re-approved. */
export function awaitsDecision(status: string): boolean {
  return status === "Pending" || status === "Expired";
}

export function formatFulfillmentCenterLabel(
  centers: Array<{ center_id: string; center_name: string }> | undefined,
): string {
  const names = (centers ?? []).map((center) => center.center_name).filter(Boolean);
  return names.length > 0 ? names.join(", ") : "Awaiting stock mapping";
}
