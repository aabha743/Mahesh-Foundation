import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch } from "@/lib/api";
import { awaitsDecision, formatFulfillmentCenterLabel, leaseStatusColors } from "@/lib/leaseRequestDisplay";
import {
  type AuditLogRow,
  type StaffLookup,
  buildStaffLookup,
  deriveMilestones,
  emptyStaffLookup,
  formatActorFromLog,
  formatActorRoleSuffix,
  formatDateOnly,
  formatDateTime,
  humanizeAuditAction,
  skipTimelineActions,
  summarizeDuration,
  timelineDescription,
} from "@/lib/leaseTimeline";
import type { LeaseRequestView as LeaseRequest } from "@/lib/uiTypes";

type TokenLeaseDetail = {
  id: string;
  token_number: string;
  requestor_name: string;
  patient_name?: string | null;
  reference_name?: string | null;
  delivery_address?: string | null;
  delivery_landmark?: string | null;
  mobile: string;
  preferred_center_id: string | null;
  fulfillment_centers?: Array<{ center_id: string; center_name: string; item_count: number; item_names: string[] }>;
  fulfillment_message?: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  rejection_reason: string | null;
  approval_comments: string | null;
  expected_duration: string | null;
  notes: string | null;
  items: Array<{ sku_id: string; sku_name: string; quantity_requested: number; asset_id: string | null }>;
  skus: string[];
};

type AssetRow = { id: string; serial_number: string; sku_id: string; center_id: string | null; status: string };

type Props = {
  /** The request whose details are shown; null closes the dialog. A new object reloads its activity. */
  request: LeaseRequest | null;
  onClose: () => void;
  /** Show approve/reject buttons for requests awaiting a decision (master admin fallback). */
  canDecide: boolean;
  submitting: boolean;
  onApprove: (request: LeaseRequest) => void;
  onReject: (request: LeaseRequest) => void;
};

/** Token details for staff: request summary, milestones, line items and the activity timeline. */
export default function TokenDetailDialog({ request, onClose, canDecide, submitting, onApprove, onReject }: Props) {
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [tokenLease, setTokenLease] = useState<TokenLeaseDetail | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogRow[]>([]);
  const transfers: Array<{
    id: string;
    from_center_id: string | null;
    to_center_id: string | null;
    status: string;
    notes: string | null;
    created_at: string;
  }> = [];
  const [assetsById, setAssetsById] = useState<Record<string, AssetRow>>({});
  const [centerNameById, setCenterNameById] = useState<Record<string, string>>({});
  const [staffLookup, setStaffLookup] = useState<StaffLookup>(emptyStaffLookup);

  const loadTokenActivity = useCallback(async (token: string) => {
    setActivityLoading(true);
    setActivityError(null);
    setTokenLease(null);
    setAuditLogs([]);
    setAssetsById({});
    setStaffLookup(emptyStaffLookup);
    try {
      const [lease, logs, assetList, centers, users] = await Promise.all([
        apiFetch<TokenLeaseDetail>(`/api/v1/lease-requests/by-token/${encodeURIComponent(token)}`),
        apiFetch<AuditLogRow[]>(`/api/v1/audit-logs?token=${encodeURIComponent(token)}&limit=500`),
        apiFetch<AssetRow[]>("/api/v1/assets"),
        apiFetch<Array<{ id: string; name: string }>>("/api/v1/centers"),
        apiFetch<Array<{ id: string; name: string; mobile: string }>>("/api/v1/users"),
      ]);
      setTokenLease(lease);
      setAuditLogs(logs);
      setAssetsById(Object.fromEntries(assetList.map((a) => [a.id, a])));
      setCenterNameById(Object.fromEntries(centers.map((c) => [c.id, c.name])));
      setStaffLookup(buildStaffLookup(users));
    } catch (e) {
      setActivityError(e instanceof Error ? e.message : "Failed to load token activity");
    } finally {
      setActivityLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!request) {
      setTokenLease(null);
      setAuditLogs([]);
      setAssetsById({});
      setStaffLookup(emptyStaffLookup);
      setActivityError(null);
      return;
    }
    void loadTokenActivity(request.token);
  }, [request, loadTokenActivity]);

  const sortedAuditsAsc = useMemo(
    () => [...auditLogs].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
    [auditLogs],
  );

  const milestones = useMemo(
    () => deriveMilestones(sortedAuditsAsc, staffLookup),
    [sortedAuditsAsc, staffLookup],
  );

  const timelineRows = useMemo(
    () => sortedAuditsAsc.filter((l) => !skipTimelineActions.has(l.action)),
    [sortedAuditsAsc],
  );

  const durationSummary = useMemo(
    () => (tokenLease ? summarizeDuration(tokenLease, milestones) : null),
    [tokenLease, milestones],
  );

  const fulfillmentCenters = tokenLease?.fulfillment_centers ?? [];
  const preferredCenterLabel =
    fulfillmentCenters.length > 0
      ? formatFulfillmentCenterLabel(fulfillmentCenters)
      : tokenLease?.preferred_center_id != null
        ? centerNameById[tokenLease.preferred_center_id] ?? "—"
        : "Awaiting stock mapping";

  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-full max-w-2xl mx-4 md:mx-auto max-h-[90vh] flex flex-col overflow-hidden gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="px-6 pt-6 pb-2 shrink-0 border-b border-border/60">
          <DialogTitle className="font-mono">Token {request?.token}</DialogTitle>
          <DialogDescription>Request summary and full activity for this token</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain px-6 py-4 max-h-[calc(90vh-7.5rem)]">
          <div className="space-y-4">
            {request && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="outline" className={cn("border", leaseStatusColors[request.status])}>{request.status}</Badge>
                <span className="text-muted-foreground">{request.requestorName}</span>
                <span className="text-muted-foreground font-mono text-xs">{request.mobile}</span>
                {canDecide && awaitsDecision(request.status) && (
                  <div className="ml-auto flex items-center gap-2">
                    <Button
                      size="sm"
                      className="gap-1 bg-success hover:bg-success/90 text-success-foreground"
                      onClick={() => onApprove(request)}
                      disabled={submitting}
                    >
                      <CheckCircle className="h-3.5 w-3.5" /> {request.status === "Expired" ? "Re-approve" : "Approve"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1 border-destructive text-destructive hover:bg-destructive/10"
                      onClick={() => onReject(request)}
                      disabled={submitting}
                    >
                      <XCircle className="h-3.5 w-3.5" /> Reject
                    </Button>
                  </div>
                )}
              </div>
            )}

            {activityLoading && <p className="text-sm text-muted-foreground">Loading activity…</p>}
            {activityError && <p className="text-sm text-destructive">{activityError}</p>}

            {!activityLoading && tokenLease && (
              <>
                <div className="rounded-lg border bg-muted/30 p-4 space-y-3 text-sm">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Milestones</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <span className="text-muted-foreground">Token raised</span>
                      <p className="font-medium">{formatDateTime(tokenLease.created_at)}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Pickup center(s)</span>
                      <p className="font-medium">{preferredCenterLabel}</p>
                    </div>
                    {milestones.approvedAt && (
                      <div>
                        <span className="text-muted-foreground">Approved</span>
                        <p className="font-medium">{formatDateTime(milestones.approvedAt)}</p>
                        <p className="text-xs text-muted-foreground">By {milestones.approvedBy}</p>
                      </div>
                    )}
                    {milestones.issuedAt && (
                      <div>
                        <span className="text-muted-foreground">Issued to patient</span>
                        <p className="font-medium">{formatDateTime(milestones.issuedAt)}</p>
                        <p className="text-xs text-muted-foreground">By {milestones.issuedBy}</p>
                      </div>
                    )}
                    {milestones.closedAt && (
                      <div>
                        <span className="text-muted-foreground">Closed (returned)</span>
                        <p className="font-medium">{formatDateTime(milestones.closedAt)}</p>
                        <p className="text-xs text-muted-foreground">Recorded by {milestones.closedBy}</p>
                      </div>
                    )}
                    {milestones.rejectedAt && (
                      <div className="sm:col-span-2">
                        <span className="text-muted-foreground">Rejected</span>
                        <p className="font-medium">{formatDateTime(milestones.rejectedAt)}</p>
                        <p className="text-xs text-muted-foreground">By {milestones.rejectedBy}</p>
                      </div>
                    )}
                  </div>

                  {tokenLease.expected_duration && (
                    <p className="text-xs text-muted-foreground">
                      Expected duration (request): <span className="text-foreground font-medium">{tokenLease.expected_duration}</span>
                    </p>
                  )}

                  {durationSummary?.kind === "closed" && (
                    <p className="text-sm">
                      <span className="text-muted-foreground">Days on lease (issue → return): </span>
                      <span className="font-semibold">{durationSummary.onLease}</span>
                      {durationSummary.expectedDays != null && (
                        <span className="text-muted-foreground text-xs ml-2">(expected ~{durationSummary.expectedDays} days)</span>
                      )}
                    </p>
                  )}
                  {durationSummary?.kind === "active" && (
                    <p className="text-sm">
                      <span className="text-muted-foreground">Days remaining (by expected duration): </span>
                      <span className="font-semibold">{durationSummary.daysLeft}</span>
                      <span className="text-muted-foreground text-xs ml-2">(due {formatDateOnly(durationSummary.dueDate)})</span>
                    </p>
                  )}
                  {durationSummary?.kind === "overdue" && (
                    <p className="text-sm text-destructive">
                      Past expected return by {durationSummary.overdueDays} day{durationSummary.overdueDays === 1 ? "" : "s"} (due{" "}
                      {formatDateOnly(durationSummary.dueDate)}).
                    </p>
                  )}
                  {durationSummary?.kind === "active_no_due" && (
                    <p className="text-sm text-muted-foreground">
                      Active lease — set a parseable expected duration (e.g. &quot;30 days&quot;) on the request to show days remaining automatically.
                      {durationSummary.expectedLabel ? ` Current value: ${durationSummary.expectedLabel}` : ""}
                    </p>
                  )}
                  {durationSummary?.kind === "closed_approx" && (
                    <p className="text-sm text-muted-foreground">
                      Closed — approximate days from submission to return: {durationSummary.approx} (issue timestamp not found in activity log).
                    </p>
                  )}
                </div>

                <div className="rounded-lg border bg-muted/30 p-4 space-y-3 text-sm">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Request &amp; Delivery Info</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <span className="text-muted-foreground">Patient's Name</span>
                      <p className="font-medium">{tokenLease.patient_name || tokenLease.requestor_name}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Referred By</span>
                      <p className="font-medium">{tokenLease.reference_name || "—"}</p>
                    </div>
                    <div className="sm:col-span-2">
                      <span className="text-muted-foreground">Delivery Address</span>
                      <p className="font-medium">{tokenLease.delivery_address || "—"}</p>
                    </div>
                    <div className="sm:col-span-2">
                      <span className="text-muted-foreground">Closest Landmark</span>
                      <p className="font-medium">{tokenLease.delivery_landmark || "—"}</p>
                    </div>
                  </div>
                </div>

                {(tokenLease.approval_comments || tokenLease.rejection_reason) && (
                  <div className="space-y-2 text-sm">
                    {tokenLease.approval_comments && (
                      <div className="rounded-md border border-success/30 bg-success/5 p-3">
                        <p className="text-xs font-medium text-success mb-1">Approver comments</p>
                        <p className="whitespace-pre-wrap">{tokenLease.approval_comments}</p>
                      </div>
                    )}
                    {tokenLease.rejection_reason && (
                      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
                        <p className="text-xs font-medium text-destructive mb-1">Rejection reason</p>
                        <p className="whitespace-pre-wrap">{tokenLease.rejection_reason}</p>
                      </div>
                    )}
                  </div>
                )}

                {tokenLease.notes?.trim() && (
                  <div className="text-sm">
                    <p className="text-xs font-medium text-muted-foreground mb-1">Notes &amp; fulfillment / edits</p>
                    <div className="rounded-md border bg-muted/40 p-3 whitespace-pre-wrap text-xs">
                      {tokenLease.notes}
                    </div>
                  </div>
                )}

                <div>
                  {fulfillmentCenters.length > 0 && (
                    <div className="mb-4 rounded-md border bg-muted/30 p-3 text-sm">
                      <p className="text-xs font-medium text-muted-foreground mb-2">Fulfillment centers</p>
                      <div className="space-y-2">
                        {fulfillmentCenters.map((center) => (
                          <div key={center.center_id} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                              <p className="font-medium text-foreground">{center.center_name}</p>
                              <p className="text-xs text-muted-foreground">
                                {center.item_names.length > 0 ? center.item_names.join(", ") : "Assigned item(s)"}
                              </p>
                            </div>
                            <Badge variant="outline" className="w-fit">
                              {center.item_count} item{center.item_count === 1 ? "" : "s"}
                            </Badge>
                          </div>
                        ))}
                      </div>
                      {tokenLease.fulfillment_message && (
                        <p className="mt-3 text-xs text-muted-foreground">{tokenLease.fulfillment_message}</p>
                      )}
                    </div>
                  )}
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Line items &amp; assets</p>
                  <div className="overflow-x-auto">
                  <Table className="min-w-[560px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>SKU</TableHead>
                        <TableHead>Qty</TableHead>
                        <TableHead>Serial</TableHead>
                        <TableHead className="hidden sm:table-cell">Asset center</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(tokenLease.items ?? []).map((item, idx) => {
                        const asset = item.asset_id ? assetsById[item.asset_id] : undefined;
                        const cname = asset?.center_id ? centerNameById[asset.center_id] ?? asset.center_id : "—";
                        return (
                          <TableRow key={`${item.sku_id}-${idx}`}>
                            <TableCell>{item.sku_name}</TableCell>
                            <TableCell>{item.quantity_requested}</TableCell>
                            <TableCell className="font-mono text-xs">{asset?.serial_number ?? (item.asset_id ? "…" : "—")}</TableCell>
                            <TableCell className="hidden sm:table-cell text-muted-foreground text-xs">{cname}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  </div>
                </div>

                {transfers.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                      Cross-center transfers linked to this token
                    </p>
                    <div className="overflow-x-auto">
                    <Table className="min-w-[620px]">
                      <TableHeader>
                        <TableRow>
                          <TableHead>When</TableHead>
                          <TableHead>Route</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="hidden sm:table-cell">Notes</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {transfers.map((t) => (
                          <TableRow key={t.id}>
                            <TableCell className="text-xs whitespace-nowrap">{formatDateTime(t.created_at)}</TableCell>
                            <TableCell className="text-xs">
                              {(t.from_center_id ? centerNameById[t.from_center_id] ?? t.from_center_id : "—")} →{" "}
                              {(t.to_center_id ? centerNameById[t.to_center_id] ?? t.to_center_id : "—")}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-xs">{t.status}</Badge>
                            </TableCell>
                            <TableCell className="hidden sm:table-cell text-xs text-muted-foreground max-w-[200px] truncate" title={t.notes ?? ""}>
                              {t.notes ?? "—"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    </div>
                  </div>
                )}

                <Separator />

                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Activity timeline</p>
                  <p className="text-[11px] text-muted-foreground mb-3">
                    From the audit ledger for this token. Routine &quot;token viewed&quot; events are hidden to reduce noise.
                  </p>
                  <ul className="space-y-3 border-l-2 border-border pl-4 ml-1">
                    {timelineRows.map((log) => (
                      <li key={log.id} className="relative">
                        <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-primary" aria-hidden />
                        <div className="text-xs text-muted-foreground">{formatDateTime(log.created_at)}</div>
                        <div className="text-sm font-medium">{humanizeAuditAction(log.action)}</div>
                        <div className="text-xs text-muted-foreground">
                          {formatActorFromLog(log, staffLookup)}
                          {formatActorRoleSuffix(log)}
                          {log.center_name ? ` · ${log.center_name}` : ""}
                        </div>
                        {timelineDescription(log) && (
                          <p className="text-xs mt-1 text-foreground/80 bg-muted/50 rounded px-2 py-1">{timelineDescription(log)}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                  {timelineRows.length === 0 && (
                    <p className="text-sm text-muted-foreground">No audit entries yet for this token (beyond routine lookups).</p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
