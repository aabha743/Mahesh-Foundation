import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Clock, CheckCircle, XCircle, Pencil, FolderCheck, Hourglass } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { type ApprovalRequest } from "@/data/approverMockData";
import { formatLeaseStatus, formatPickupCenterLabel } from "@/lib/utils";
import { apiFetch, type LeaseRequestStatus } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { useLeaseRequestCounts, useLeaseRequestPages } from "@/hooks/useLeaseRequestPages";
import { RequiredMark } from "@/components/RequiredMark";
import { RejectRequestDialog } from "@/components/lease/RejectRequestDialog";
import { ShowMoreButton } from "@/components/ShowMoreButton";

type ApprovalTab = "pending" | "approved" | "expired" | "reviewed" | "rejected";

const validTabs: ApprovalTab[] = ["pending", "approved", "expired", "reviewed", "rejected"];

/** The statuses each tab asks the server for; Reviewed is everything except pending. */
const tabStatuses: Record<ApprovalTab, LeaseRequestStatus[]> = {
  pending: ["pending"],
  approved: ["approved"],
  expired: ["expired"],
  reviewed: ["approved", "active", "closed", "expired", "rejected"],
  rejected: ["rejected"],
};

type LeaseRequestApi = {
  id: string;
  token_number: string;
  preferred_center_id: string | null;
  requestor_name: string;
  patient_name?: string | null;
  delivery_address?: string | null;
  delivery_landmark?: string | null;
  mobile: string;
  aadhar_number: string;
  reference_name: string | null;
  expected_duration: string | null;
  notes: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  rejection_reason: string | null;
  fulfillment_centers?: Array<{ center_id: string; center_name: string }>;
  skus: string[];
  items?: Array<{ sku_id: string; sku_name: string; quantity_requested: number }>;
};

function toApprovalRequest(r: LeaseRequestApi, centerNameById: Record<string, string>): ApprovalRequest {
  const submitted = new Date(r.created_at);
  const now = new Date();
  const daysWaiting = Math.max(0, Math.floor((now.getTime() - submitted.getTime()) / (1000 * 60 * 60 * 24)));
  const status = formatLeaseStatus(r.status) as ApprovalRequest["status"];
  const items = (r.items ?? []).length
    ? (r.items ?? []).map((item) => ({ sku: item.sku_name, qty: item.quantity_requested }))
    : (r.skus ?? []).map((sku) => ({ sku, qty: 1 }));

  return {
    id: r.id,
    token: r.token_number,
    requestorName: r.requestor_name,
    patientName: r.patient_name || r.requestor_name,
    deliveryAddress: r.delivery_address || "",
    deliveryLandmark: r.delivery_landmark || "",
    mobile: r.mobile,
    aadhar: r.aadhar_number,
    items,
    preferredCenter: formatPickupCenterLabel(
      status,
      (r.fulfillment_centers ?? []).map((center) => center.center_name),
      r.preferred_center_id ? centerNameById[r.preferred_center_id] : undefined,
    ),
    referredBy: r.reference_name || "Not provided",
    submittedDate: r.created_at.slice(0, 10),
    daysWaiting,
    status,
    reviewedDate: status === "Pending" ? undefined : r.updated_at.slice(0, 10),
    rejectionReason: r.rejection_reason ?? undefined,
    notes: r.notes ?? undefined,
    expectedDuration: r.expected_duration ?? undefined,
  };
}

function DaysWaitingBadge({ days }: { days: number }) {
  // Highlights aging pending requests so approvers can prioritize quickly.
  const color = days > 5 ? "bg-destructive/15 text-destructive border-destructive/30" : days > 2 ? "bg-warning/15 text-warning border-warning/30" : "bg-muted text-muted-foreground border-border";
  return <Badge variant="outline" className={color}>{days}d waiting</Badge>;
}

export default function ApprovalsList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") || "pending";
  const currentTab: ApprovalTab = validTabs.includes(tab as ApprovalTab) ? (tab as ApprovalTab) : "pending";
  const [centerNameById, setCenterNameById] = useState<Record<string, string>>({});
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);

  // Edit state
  const [editReq, setEditReq] = useState<ApprovalRequest | null>(null);
  const [editItems, setEditItems] = useState<{ sku: string; qty: number }[]>([]);
  const [editComment, setEditComment] = useState("");
  const [skuNameToIdMap, setSkuNameToIdMap] = useState<Record<string, string>>({});

  // Each tab asks the server for its own statuses, a page at a time.
  const { rows, hasMore, loading, loadingMore, loadMore, reload } = useLeaseRequestPages<LeaseRequestApi>(
    { status: tabStatuses[currentTab] },
    "Could not load approvals",
  );
  const { counts, reload: reloadCounts } = useLeaseRequestCounts();

  const requests = useMemo(() => rows.map((r) => toApprovalRequest(r, centerNameById)), [rows, centerNameById]);

  const statusCount = (status: LeaseRequestStatus) => counts?.by_status[status] ?? 0;
  const reviewedCount = counts ? counts.total - counts.by_status.pending : 0;

  useEffect(() => {
    // Loads SKU ids (for item edits) and center names (for the pickup center label).
    async function loadData() {
      try {
        const [skus, centers] = await Promise.all([
          apiFetch<Array<{ id: string; name: string }>>("/api/v1/skus"),
          apiFetch<Array<{ id: string; name: string }>>("/api/v1/centers?include_inactive=true"),
        ]);
        setSkuNameToIdMap(Object.fromEntries(skus.map((s) => [s.name, s.id])));
        setCenterNameById(Object.fromEntries(centers.map((c) => [c.id, c.name])));
      } catch {
        toast.error("Could not load approvals");
      }
    }
    loadData();
  }, []);

  const refreshAfterChange = () => {
    // Requests move between tabs after a decision, so reload this tab's first page and the counts.
    void reload();
    void reloadCounts();
  };

  const handleApprove = async (req: ApprovalRequest, e: React.MouseEvent) => {
    // Approves a pending request (or re-approves an expired one).
    e.stopPropagation();
    const isReapproval = req.status === "Expired";
    try {
      await apiFetch(`/api/v1/lease-requests/${req.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "approved" }),
      });
    } catch {
      toast.error(`Failed to approve ${req.token}`);
      return;
    }
    toast.success(`Request ${req.token} ${isReapproval ? "re-approved" : "approved"}`);
    refreshAfterChange();
  };

  const handleRejectOpen = (id: string, e: React.MouseEvent) => {
    // Opens rejection modal for the selected request.
    e.stopPropagation();
    setRejectId(id);
  };

  const handleRejectConfirm = async () => {
    // Rejects the request (no reason is asked for).
    const req = requests.find((r) => r.id === rejectId);
    if (!req) return;
    setRejecting(true);
    try {
      await apiFetch(`/api/v1/lease-requests/${req.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "rejected" }),
      });
    } catch {
      toast.error(`Failed to reject ${req.token}`);
      return;
    } finally {
      setRejecting(false);
    }
    toast.error(`Request ${req.token} rejected`);
    setRejectId(null);
    refreshAfterChange();
  };

  const handleEditOpen = (req: ApprovalRequest, e: React.MouseEvent) => {
    // Opens approver edit modal with current request items.
    e.stopPropagation();
    setEditReq(req);
    setEditItems(req.items.map((i) => ({ ...i })));
    setEditComment("");
  };

  const handleEditSave = async () => {
    // Saves approver item edits and appends an immutable edit note.
    if (!editReq || !editComment.trim()) return;
    const noteToAppend = `[Approver Edit] ${editComment}`;
    const updatedNotes = (editReq.notes ? `${editReq.notes}\n` : "") + noteToAppend;
    const itemPayload = editItems.map((item) => {
      const skuId = skuNameToIdMap[item.sku];
      return { sku_id: skuId, quantity_requested: item.qty };
    });
    if (itemPayload.some((item) => !item.sku_id)) {
      toast.error("Could not map one or more SKUs to IDs");
      return;
    }
    try {
      await apiFetch(`/api/v1/lease-requests/${editReq.id}`, {
        method: "PATCH",
        body: JSON.stringify({ notes: updatedNotes, items: itemPayload }),
      });
    } catch {
      toast.error(`Failed to update ${editReq.token}`);
      return;
    }
    toast.success(`Request ${editReq.token} updated`);
    setEditReq(null);
    refreshAfterChange();
  };

  const updateEditItemQty = (index: number, qty: number) => {
    // Enforces a minimum quantity of 1 while editing request items.
    setEditItems((items) => items.map((item, i) => i === index ? { ...item, qty: Math.max(1, qty) } : item));
  };

  const reviewedBadgeClass = (status: ApprovalRequest["status"]) => {
    switch (status) {
      case "Approved":
        return "bg-success/15 text-success border-success/30";
      case "Active":
        return "bg-primary/10 text-primary border-primary/30";
      case "Closed":
        return "bg-muted text-muted-foreground border-border";
      case "Expired":
        return "bg-warning/15 text-warning border-warning/30";
      default:
        return "bg-destructive/15 text-destructive border-destructive/30";
    }
  };

  const renderCard = (req: ApprovalRequest, isPending: boolean) => {
    // Shared card renderer for pending, expired and reviewed tabs.
    const isExpired = req.status === "Expired";
    return (
    <Card key={req.id} className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => navigate(`/approvals/${req.id}`)}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="font-mono font-bold text-foreground">{req.token}</span>
          <div className="flex items-center gap-2">
            {isPending && <DaysWaitingBadge days={req.daysWaiting} />}
            {!isPending && (
              <Badge variant="outline" className={reviewedBadgeClass(req.status)}>
                {req.status}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">{isPending ? req.submittedDate : req.reviewedDate}</span>
          </div>
        </div>

        <div className="text-sm space-y-1">
          <p>
            <span className="text-muted-foreground">Requestor:</span> {req.requestorName}
            {req.patientName && req.patientName !== req.requestorName && (
              <span className="text-muted-foreground text-xs ml-2"> (Patient: {req.patientName})</span>
            )}
          </p>
          <p><span className="text-muted-foreground">Mobile:</span> {req.mobile} &nbsp; <span className="text-muted-foreground">Aadhar:</span> {req.aadhar}</p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {req.items.map((item, index) => (
            <Badge key={`${item.sku}-${index}`} variant="secondary" className="text-xs">{item.qty}x {item.sku}</Badge>
          ))}
        </div>

        <div className="flex items-center justify-between flex-wrap gap-2">
          <Badge variant="outline">{req.preferredCenter}</Badge>
          <span className="text-xs italic text-muted-foreground">Referred by {req.referredBy}</span>
        </div>

        {!isPending && req.rejectionReason && (
          <p className="text-xs text-destructive bg-destructive/5 p-2 rounded">{req.rejectionReason}</p>
        )}

        {req.notes && (
          <p className="text-xs text-muted-foreground bg-muted p-2 rounded">{req.notes}</p>
        )}

        {isExpired && (
          <p className="text-xs text-warning bg-warning/5 p-2 rounded">
            Not collected within the pickup window. Re-approving reserves stock again and sends the approval SMS.
          </p>
        )}

        {(isPending || isExpired) && (
          <div className="flex flex-wrap gap-2 pt-1">
            {can("requests.approve") && (
              <Button size="sm" className="bg-success hover:bg-success/90 text-success-foreground gap-1" onClick={(e) => handleApprove(req, e)}>
                <CheckCircle className="h-3.5 w-3.5" /> {isExpired ? "Re-approve" : "Approve"}
              </Button>
            )}
            {can("requests.reject") && (
              <Button size="sm" variant="outline" className="border-destructive text-destructive hover:bg-destructive/10 gap-1" onClick={(e) => handleRejectOpen(req.id, e)}>
                <XCircle className="h-3.5 w-3.5" /> Reject
              </Button>
            )}
            {isPending && can("requests.edit") && (
              <Button size="sm" variant="outline" className="gap-1 ml-auto" onClick={(e) => handleEditOpen(req, e)}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
    );
  };

  return (
    <div className="space-y-4">
      <Tabs value={currentTab} onValueChange={(v) => setSearchParams({ tab: v })}>
        <TabsList>
          <TabsTrigger value="pending" className="gap-1"><Clock className="h-3.5 w-3.5" /> Pending ({statusCount("pending")})</TabsTrigger>
          <TabsTrigger value="approved" className="gap-1"><CheckCircle className="h-3.5 w-3.5" /> Approved ({statusCount("approved")})</TabsTrigger>
          <TabsTrigger value="expired" className="gap-1"><Hourglass className="h-3.5 w-3.5" /> Expired ({statusCount("expired")})</TabsTrigger>
          <TabsTrigger value="reviewed" className="gap-1"><FolderCheck className="h-3.5 w-3.5" /> Reviewed ({reviewedCount})</TabsTrigger>
          <TabsTrigger value="rejected" className="gap-1"><XCircle className="h-3.5 w-3.5" /> Rejected ({statusCount("rejected")})</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {requests.map((r) => renderCard(r, currentTab === "pending"))}
      </div>

      <ShowMoreButton hasMore={hasMore} loading={loadingMore} onClick={() => void loadMore()} />

      {loading && requests.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-sm">Loading requests...</p>
        </div>
      )}

      {!loading && currentTab === "pending" && requests.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <CheckCircle className="h-12 w-12 mx-auto mb-3 text-success" />
          <p className="text-lg font-medium">All caught up!</p>
          <p className="text-sm">No pending approvals</p>
        </div>
      )}

      {!loading && currentTab === "approved" && requests.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <CheckCircle className="h-12 w-12 mx-auto mb-3 text-success" />
          <p className="text-lg font-medium">No approved requests</p>
          <p className="text-sm">Approved requests will appear here</p>
        </div>
      )}

      {!loading && currentTab === "expired" && requests.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <Hourglass className="h-12 w-12 mx-auto mb-3 text-warning" />
          <p className="text-lg font-medium">No expired requests</p>
          <p className="text-sm">Approved requests not collected within the pickup window will appear here</p>
        </div>
      )}

      {!loading && currentTab === "reviewed" && requests.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <FolderCheck className="h-12 w-12 mx-auto mb-3 text-primary" />
          <p className="text-lg font-medium">No reviewed requests</p>
          <p className="text-sm">Reviewed tokens will appear here</p>
        </div>
      )}

      {!loading && currentTab === "rejected" && requests.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <XCircle className="h-12 w-12 mx-auto mb-3 text-destructive" />
          <p className="text-lg font-medium">No rejected requests</p>
          <p className="text-sm">Rejected requests will appear here</p>
        </div>
      )}

      {/* Reject Dialog */}
      <RejectRequestDialog
        token={requests.find((r) => r.id === rejectId)?.token ?? null}
        submitting={rejecting}
        onCancel={() => setRejectId(null)}
        onConfirm={() => void handleRejectConfirm()}
      />

      {/* Edit Dialog */}
      <Dialog open={!!editReq} onOpenChange={() => setEditReq(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Edit Request — {editReq?.token}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-3">
              <Label className="text-sm font-medium">Requested Items</Label>
              {editItems.map((item, i) => (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-sm flex-1">{item.sku}</span>
                  <Input
                    type="number"
                    min={1}
                    value={item.qty}
                    onChange={(e) => updateEditItemQty(i, parseInt(e.target.value) || 1)}
                    className="w-20"
                  />
                </div>
              ))}
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-medium">Reason for edit<RequiredMark /></Label>
              <Textarea
                placeholder="Explain why the request was modified (required)..."
                value={editComment}
                onChange={(e) => setEditComment(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditReq(null)}>Cancel</Button>
            <Button onClick={handleEditSave} disabled={!editComment.trim()}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function dbStatusToUi(status: string): ApprovalRequest["status"] {
  // Maps backend status values to approver screen status labels.
  switch (status) {
    case "pending":
      return "Pending";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "expired":
      return "Expired";
    default:
      return "Pending";
  }
}
