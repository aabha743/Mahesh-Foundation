import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle, Eye, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { type LeaseRequestView as LeaseRequest, type LeaseStatus } from "@/lib/uiTypes";
import { formatLeaseStatus } from "@/lib/utils";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";

const statusColors: Record<LeaseStatus, string> = {
  Pending: "bg-warning/10 text-warning border-warning/20",
  Approved: "bg-success/10 text-success border-success/20",
  Rejected: "bg-destructive/10 text-destructive border-destructive/20",
  Active: "bg-primary/10 text-primary border-primary/20",
  Closed: "bg-muted text-muted-foreground border-border",
};

const tabs = ["All", "Pending", "Approved", "Active", "Closed"] as const;

type TokenLeaseDetail = {
  id: string;
  token_number: string;
  requestor_name: string;
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

type AuditLogRow = {
  id: string;
  user_id: string | null;
  center_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
  section?: string;
  user_name?: string | null;
  center_name?: string | null;
};

// type TransferRow = {
//   id: string;
//   asset_id: string;
//   from_center_id: string | null;
//   to_center_id: string | null;
//   reference_number?: string | null;
//   status: string;
//   transfer_reason: string | null;
//   notes: string | null;
//   created_at: string;
//   completed_at: string | null;
// };

type AssetRow = { id: string; serial_number: string; sku_id: string; center_id: string | null; status: string };

type StaffLookup = {
  nameByUserId: Record<string, string>;
  nameByMobile: Record<string, string>;
};

const emptyStaffLookup: StaffLookup = { nameByUserId: {}, nameByMobile: {} };

function normalizeMobile(m: string): string {
  return m.replace(/\D/g, "").slice(-10) || m;
}

function parseDurationDays(expected: string | null | undefined): number | null {
  if (!expected?.trim()) return null;
  const lower = expected.trim().toLowerCase();
  const num = parseInt(lower.match(/\d+/)?.[0] ?? "", 10);
  if (!Number.isFinite(num)) return null;
  if (lower.includes("week")) return num * 7;
  if (lower.includes("month")) return num * 30;
  if (lower.includes("day")) return num;
  return num;
}

function strField(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatDateOnly(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso.slice(0, 10);
  }
}

function daysBetween(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

/** Resolves audit actor for display (handles legacy `actor_mobile: "public"` from older API logs). */
function formatActorFromLog(log: AuditLogRow, staff: StaffLookup): string {
  const named = log.user_name?.trim();
  if (named) return named;
  const uid = log.user_id;
  if (uid && staff.nameByUserId[uid]) return staff.nameByUserId[uid];
  const raw = log.new_value?.actor_mobile;
  const mobile = typeof raw === "string" ? raw.trim() : "";
  if (mobile && /^\d{10}$/.test(mobile)) {
    return staff.nameByMobile[mobile] ?? mobile;
  }
  if (!mobile || mobile.toLowerCase() === "public") {
    const role = typeof log.new_value?.actor_role === "string" ? log.new_value.actor_role.trim() : "";
    if (role && role.toLowerCase() !== "public") {
      const label = role.replace(/_/g, " ");
      return `Staff (${label}) — name not in log; stay logged in when acting`;
    }
    return "Not recorded — stay logged in on staff pages so actions are attributed to you";
  }
  return mobile;
}

function formatActorRoleSuffix(log: AuditLogRow): string {
  const r = log.new_value?.actor_role;
  if (typeof r !== "string" || !r.trim()) return "";
  if (r.trim().toLowerCase() === "public") return "";
  return ` · ${r.replace(/_/g, " ")}`;
}

function humanizeAuditAction(action: string): string {
  const labels: Record<string, string> = {
    request_created: "Request submitted (token issued)",
    approve_request: "Approved",
    reject_request: "Rejected",
    request_updated: "Request / fulfillment updated",
    token_viewed: "Token looked up",
  };
  return labels[action] ?? action.replace(/_/g, " ");
}

/** Derives milestone timestamps from audit rows (sorted ascending). */
function deriveMilestones(sortedAsc: AuditLogRow[], staff: StaffLookup) {
  let approvedAt: string | undefined;
  let approvedBy: string | undefined;
  let issuedAt: string | undefined;
  let issuedBy: string | undefined;
  let closedAt: string | undefined;
  let closedBy: string | undefined;
  let rejectedAt: string | undefined;
  let rejectedBy: string | undefined;

  for (const log of sortedAsc) {
    if (log.action === "approve_request") {
      approvedAt = log.created_at;
      approvedBy = formatActorFromLog(log, staff);
    }
    if (log.action === "reject_request") {
      rejectedAt = log.created_at;
      rejectedBy = formatActorFromLog(log, staff);
    }
    if (log.action === "request_updated") {
      const oldS = strField(log.old_value?.status);
      const newS = strField(log.new_value?.status);
      if ((newS === "issued" || newS === "partially_returned") && oldS !== "issued" && oldS !== "partially_returned") {
        if (!issuedAt) {
          issuedAt = log.created_at;
          issuedBy = formatActorFromLog(log, staff);
        }
      }
      if (newS === "returned" && oldS !== "returned") {
        closedAt = log.created_at;
        closedBy = formatActorFromLog(log, staff);
      }
    }
  }

  return { approvedAt, approvedBy, issuedAt, issuedBy, closedAt, closedBy, rejectedAt, rejectedBy };
}

function timelineDescription(log: AuditLogRow): string | null {
  const nv = log.new_value ?? {};
  const ov = log.old_value ?? {};
  if (log.action === "request_updated") {
    const oldS = strField(ov.status);
    const newS = strField(nv.status);
    if (oldS && newS && oldS !== newS) return `Status: ${oldS} → ${newS}`;
    const notes = strField(nv.notes);
    if (notes?.includes("[Approver Edit]")) return "Approver edited line items or notes";
    if (notes?.includes("fulfillment:")) return "Fulfillment / issue notes updated";
  }
  if (log.action === "approve_request") {
    const c = strField(nv.approval_comments);
    return c ? `Comments: ${c}` : null;
  }
  if (log.action === "reject_request") {
    const r = strField(nv.rejection_reason);
    return r ? `Reason recorded in log: ${r}` : null;
  }
  return null;
}

const skipTimelineActions = new Set(["token_viewed", "requests_list_viewed"]);

function formatFulfillmentCenterLabel(
  centers: Array<{ center_id: string; center_name: string }> | undefined,
): string {
  const names = (centers ?? []).map((center) => center.center_name).filter(Boolean);
  return names.length > 0 ? names.join(", ") : "Awaiting stock mapping";
}

export default function LeaseRequestsPage() {
  const { activeRole, can, hasRole } = useAuth();
  const [activeTab, setActiveTab] = useState("All");
  const [viewRequest, setViewRequest] = useState<LeaseRequest | null>(null);
  const [leaseRequests, setLeaseRequests] = useState<LeaseRequest[]>([]);
  const [submittingAction, setSubmittingAction] = useState(false);
  const [rejectRequest, setRejectRequest] = useState<LeaseRequest | null>(null);
  const [rejectReason, setRejectReason] = useState("");

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

  const filtered = useMemo(() => {
    return activeTab === "All" ? leaseRequests : leaseRequests.filter((r) => r.status === activeTab);
  }, [activeTab, leaseRequests]);

  const canUseAdminFallback =
    hasRole("master_admin") &&
    activeRole === "master_admin" &&
    can("requests.approve") &&
    can("requests.reject");

  const reloadLeaseRequests = useCallback(async () => {
    const [centers, requests] = await Promise.all([
      apiFetch<Array<{ id: string; name: string }>>("/api/v1/centers"),
      apiFetch<
        Array<{
          id: string;
          token_number: string;
          requestor_name: string;
          patient_name?: string | null;
          mobile: string;
          preferred_center_id: string | null;
          fulfillment_centers?: Array<{ center_id: string; center_name: string }>;
          status: string;
          created_at: string;
          skus: string[];
        }>
      >("/api/v1/lease-requests"),
    ]);

    const centerMap = Object.fromEntries(centers.map((c) => [c.id, c.name]));
    const mapped: LeaseRequest[] = requests.map((req) => ({
      id: req.id,
      token: req.token_number,
      requestorName: req.requestor_name,
      patientName: req.patient_name,
      mobile: req.mobile,
      skus: req.skus ?? [],
      preferredCenter:
        (req.fulfillment_centers ?? []).length > 0
          ? formatFulfillmentCenterLabel(req.fulfillment_centers)
          : req.preferred_center_id
            ? centerMap[req.preferred_center_id] ?? "Unknown Center"
            : "Awaiting stock mapping",
      status: formatLeaseStatus(req.status) as LeaseStatus,
      submittedDate: req.created_at.slice(0, 10),
    }));

    setLeaseRequests(mapped);
    return mapped;
  }, []);

  useEffect(() => {
    async function loadLeaseRequests() {
      try {
        await reloadLeaseRequests();
      } catch {
        toast.error("Could not load lease requests from API");
      }
    }

    loadLeaseRequests();
  }, [reloadLeaseRequests]);

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
      const nameByUserId: Record<string, string> = {};
      const nameByMobile: Record<string, string> = {};
      for (const u of users) {
        nameByUserId[u.id] = u.name;
        const key = normalizeMobile(u.mobile);
        if (key.length === 10) nameByMobile[key] = u.name;
      }
      setStaffLookup({ nameByUserId, nameByMobile });
    } catch (e) {
      setActivityError(e instanceof Error ? e.message : "Failed to load token activity");
    } finally {
      setActivityLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!viewRequest) {
      setTokenLease(null);
      setAuditLogs([]);
      setAssetsById({});
      setStaffLookup(emptyStaffLookup);
      setActivityError(null);
      return;
    }
    void loadTokenActivity(viewRequest.token);
  }, [viewRequest, loadTokenActivity]);

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

  const durationSummary = useMemo(() => {
    if (!tokenLease) return null;
    const expectedDays = parseDurationDays(tokenLease.expected_duration);
    const uiStatus = formatLeaseStatus(tokenLease.status) as LeaseStatus;
    const issueDate = milestones.issuedAt ? new Date(milestones.issuedAt) : null;
    const closeDate = milestones.closedAt ? new Date(milestones.closedAt) : null;
    const submitted = new Date(tokenLease.created_at);

    if (uiStatus === "Closed" && issueDate && closeDate) {
      const onLease = daysBetween(issueDate, closeDate);
      return { kind: "closed" as const, onLease, expectedDays };
    }
    if (uiStatus === "Active" && issueDate && expectedDays != null) {
      const due = new Date(issueDate);
      due.setDate(due.getDate() + expectedDays);
      const now = new Date();
      if (due.getTime() < now.getTime()) {
        const overdue = daysBetween(due, now);
        return { kind: "overdue" as const, overdueDays: overdue, dueDate: due.toISOString(), expectedDays };
      }
      const left = daysBetween(now, due);
      return { kind: "active" as const, daysLeft: left, dueDate: due.toISOString(), expectedDays };
    }
    if (uiStatus === "Active" && issueDate && expectedDays == null) {
      return { kind: "active_no_due" as const, expectedLabel: tokenLease.expected_duration };
    }
    if (uiStatus === "Closed" && closeDate && !issueDate) {
      const approx = daysBetween(submitted, closeDate);
      return { kind: "closed_approx" as const, approx };
    }
    return null;
  }, [tokenLease, milestones]);

  const fulfillmentCenters = tokenLease?.fulfillment_centers ?? [];
  const preferredCenterLabel =
    fulfillmentCenters.length > 0
      ? formatFulfillmentCenterLabel(fulfillmentCenters)
      : tokenLease?.preferred_center_id != null
        ? centerNameById[tokenLease.preferred_center_id] ?? "—"
        : "Awaiting stock mapping";

  const refreshAfterMutation = useCallback(
    async (request: LeaseRequest) => {
      const latest = await reloadLeaseRequests();
      const updated = latest.find((item) => item.id === request.id) ?? null;
      if (updated) {
        setViewRequest(updated);
      }
      await loadTokenActivity(request.token);
    },
    [loadTokenActivity, reloadLeaseRequests],
  );

  const handleApprove = useCallback(
    async (request: LeaseRequest) => {
      setSubmittingAction(true);
      try {
        await apiFetch(`/api/v1/lease-requests/${request.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            status: "approved",
            approval_comments: "Approved by Master Admin fallback from Lease Requests page",
          }),
        });
        toast.success(`Approved ${request.token}`);
        await refreshAfterMutation(request);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to approve request");
      } finally {
        setSubmittingAction(false);
      }
    },
    [refreshAfterMutation],
  );

  const handleRejectConfirm = useCallback(async () => {
    if (!rejectRequest) return;
    if (rejectReason.trim().length < 20) {
      toast.error("Please enter at least 20 characters for the rejection reason");
      return;
    }

    setSubmittingAction(true);
    try {
      await apiFetch(`/api/v1/lease-requests/${rejectRequest.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "rejected",
          rejection_reason: rejectReason.trim(),
        }),
      });
      toast.success(`Rejected ${rejectRequest.token}`);
      await refreshAfterMutation(rejectRequest);
      setRejectRequest(null);
      setRejectReason("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to reject request");
    } finally {
      setSubmittingAction(false);
    }
  }, [refreshAfterMutation, rejectReason, rejectRequest]);

  return (
    <div className="space-y-4">
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex-wrap">
          {tabs.map((tab) => (
            <TabsTrigger key={tab} value={tab}>
              {tab}
              <span className="ml-1.5 text-xs opacity-60">
                ({tab === "All" ? leaseRequests.length : leaseRequests.filter((r) => r.status === tab).length})
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Card>
        <CardContent className="p-0">
          <div className="hidden md:block overflow-x-auto">
          <Table className="min-w-[880px]">
            <TableHeader>
              <TableRow>
                <TableHead>Token</TableHead>
                <TableHead>Requestor</TableHead>
                <TableHead className="hidden sm:table-cell">Mobile</TableHead>
                <TableHead className="hidden md:table-cell">SKUs</TableHead>
                <TableHead className="hidden lg:table-cell">Pickup Center(s)</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Date</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((req) => (
                <TableRow key={req.id}>
                  <TableCell>
                    <button className="font-mono text-sm text-primary hover:underline" onClick={() => setViewRequest(req)}>
                      {req.token}
                    </button>
                  </TableCell>
                  <TableCell className="font-medium">
                    <div>{req.requestorName}</div>
                    {req.patientName && req.patientName !== req.requestorName && (
                      <div className="text-xs text-muted-foreground font-normal">Patient: {req.patientName}</div>
                    )}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell font-mono text-sm text-muted-foreground">{req.mobile}</TableCell>
                  <TableCell className="hidden md:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {req.skus.length > 0
                        ? req.skus.map((sku) => (
                            <Badge key={sku} variant="secondary" className="text-xs">{sku}</Badge>
                          ))
                        : <span className="text-xs text-muted-foreground">No items</span>}
                    </div>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-muted-foreground">{req.preferredCenter}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn("border", statusColors[req.status])}>{req.status}</Badge>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell text-muted-foreground">{req.submittedDate}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {canUseAdminFallback && req.status === "Pending" && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-success hover:text-success"
                            onClick={() => void handleApprove(req)}
                            disabled={submittingAction}
                            title="Approve pending request"
                          >
                            <CheckCircle className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            onClick={() => {
                              setRejectRequest(req);
                              setRejectReason("");
                            }}
                            disabled={submittingAction}
                            title="Reject pending request"
                          >
                            <XCircle className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setViewRequest(req)}>
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">No requests found</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
          </div>

          <div className="md:hidden space-y-3 p-4">
            {filtered.map((req) => (
              <div key={req.id} className="rounded-lg border bg-card p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <button className="font-mono text-sm font-bold text-primary hover:underline" onClick={() => setViewRequest(req)}>
                      {req.token}
                    </button>
                    <p className="font-medium text-foreground mt-1">{req.requestorName}</p>
                    {req.patientName && req.patientName !== req.requestorName && (
                      <p className="text-xs text-muted-foreground">Patient: {req.patientName}</p>
                    )}
                  </div>
                  <Badge variant="outline" className={cn("border", statusColors[req.status])}>{req.status}</Badge>
                </div>
                <div className="text-sm text-muted-foreground space-y-1">
                  <p>Pickup center(s): <span className="text-foreground">{req.preferredCenter}</span></p>
                  <p>Submitted: <span className="text-foreground">{req.submittedDate}</span></p>
                </div>
                <div className="flex flex-wrap gap-1">
                  {req.skus.length > 0
                    ? req.skus.map((sku) => (
                        <Badge key={sku} variant="secondary" className="text-xs">{sku}</Badge>
                      ))
                    : <span className="text-xs text-muted-foreground">No items</span>}
                </div>
                <div className="flex flex-col gap-2">
                  {canUseAdminFallback && req.status === "Pending" && (
                    <>
                      <Button size="sm" className="w-full justify-start bg-success hover:bg-success/90 text-success-foreground" onClick={() => void handleApprove(req)} disabled={submittingAction}>
                        <CheckCircle className="h-4 w-4 mr-2" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full justify-start border-destructive text-destructive hover:bg-destructive/10"
                        onClick={() => {
                          setRejectRequest(req);
                          setRejectReason("");
                        }}
                        disabled={submittingAction}
                      >
                        <XCircle className="h-4 w-4 mr-2" />
                        Reject
                      </Button>
                    </>
                  )}
                  <Button variant="outline" size="sm" className="w-full justify-start" onClick={() => setViewRequest(req)}>
                    <Eye className="h-4 w-4 mr-2" />
                    View details
                  </Button>
                </div>
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">No requests found</div>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!viewRequest} onOpenChange={(open) => !open && setViewRequest(null)}>
        <DialogContent className="w-full max-w-2xl mx-4 md:mx-auto max-h-[90vh] flex flex-col overflow-hidden gap-0 p-0 sm:max-w-2xl">
          <DialogHeader className="px-6 pt-6 pb-2 shrink-0 border-b border-border/60">
            <DialogTitle className="font-mono">Token {viewRequest?.token}</DialogTitle>
            <DialogDescription>Request summary and full activity for this token</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain px-6 py-4 max-h-[calc(90vh-7.5rem)]">
            <div className="space-y-4">
              {viewRequest && (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant="outline" className={cn("border", statusColors[viewRequest.status])}>{viewRequest.status}</Badge>
                  <span className="text-muted-foreground">{viewRequest.requestorName}</span>
                  <span className="text-muted-foreground font-mono text-xs">{viewRequest.mobile}</span>
                  {canUseAdminFallback && viewRequest.status === "Pending" && (
                    <div className="ml-auto flex items-center gap-2">
                      <Button
                        size="sm"
                        className="gap-1 bg-success hover:bg-success/90 text-success-foreground"
                        onClick={() => void handleApprove(viewRequest)}
                        disabled={submittingAction}
                      >
                        <CheckCircle className="h-3.5 w-3.5" /> Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1 border-destructive text-destructive hover:bg-destructive/10"
                        onClick={() => {
                          setRejectRequest(viewRequest);
                          setRejectReason("");
                        }}
                        disabled={submittingAction}
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

      <Dialog
        open={!!rejectRequest}
        onOpenChange={(open) => {
          if (!open && !submittingAction) {
            setRejectRequest(null);
            setRejectReason("");
          }
        }}
      >
        <DialogContent className="w-full max-w-md mx-4 md:mx-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject Pending Request</DialogTitle>
            <DialogDescription>
              {rejectRequest ? `Provide a reason for rejecting token ${rejectRequest.token}.` : "Provide a rejection reason."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea
              placeholder="Reason for rejection (minimum 20 characters)"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={4}
              disabled={submittingAction}
            />
            <p className="text-xs text-muted-foreground">{rejectReason.trim().length}/20 characters minimum</p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setRejectRequest(null);
                  setRejectReason("");
                }}
                disabled={submittingAction}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => void handleRejectConfirm()}
                disabled={submittingAction || rejectReason.trim().length < 20}
              >
                {submittingAction ? "Rejecting..." : "Submit Rejection"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
