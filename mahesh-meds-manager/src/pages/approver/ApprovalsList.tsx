import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Clock, CheckCircle, XCircle, Pencil, FolderCheck } from "lucide-react";
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
import { formatLeaseStatus } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";

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
  const validTabs = ["pending", "approved", "reviewed", "rejected"];
  const currentTab = validTabs.includes(tab) ? tab : "pending";
  const [pending, setPending] = useState<ApprovalRequest[]>([]);
  const [approved, setApproved] = useState<ApprovalRequest[]>([]);
  const [reviewed, setReviewed] = useState<ApprovalRequest[]>([]);
  const [rejected, setRejected] = useState<ApprovalRequest[]>([]);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  // Edit state
  const [editReq, setEditReq] = useState<ApprovalRequest | null>(null);
  const [editItems, setEditItems] = useState<{ sku: string; qty: number }[]>([]);
  const [editComment, setEditComment] = useState("");
  const [skuNameToIdMap, setSkuNameToIdMap] = useState<Record<string, string>>({});

  useEffect(() => {
    // Loads pending/reviewed requests and enriches each row with availability counts.
    async function loadData() {
      try {
        const [requests, skus] = await Promise.all([
          apiFetch<Array<{
            id: string;
            token_number: string;
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
          }>>("/api/v1/lease-requests"),
          apiFetch<Array<{ id: string; name: string }>>("/api/v1/skus"),
        ]);

        const skuInventory = await apiFetch<Array<{ sku_id: string; status: string }>>("/api/v1/assets");
        const stockBySkuId: Record<string, number> = {};
        skuInventory.forEach((a) => {
          if (a.status !== "available") return;
          stockBySkuId[a.sku_id] = (stockBySkuId[a.sku_id] ?? 0) + 1;
        });
        const skuNameToId = Object.fromEntries(skus.map((s) => [s.name, s.id]));
        setSkuNameToIdMap(skuNameToId);

        const mapped: ApprovalRequest[] = requests.map((r) => {
          const submitted = new Date(r.created_at);
          const now = new Date();
          const daysWaiting = Math.max(0, Math.floor((now.getTime() - submitted.getTime()) / (1000 * 60 * 60 * 24)));
          const status = formatLeaseStatus(r.status) as ApprovalRequest["status"];
          const items = (r.items ?? []).length
            ? (r.items ?? []).map((item) => ({ sku: item.sku_name, qty: item.quantity_requested }))
            : (r.skus ?? []).map((sku) => ({ sku, qty: 1 }));
          const availability = Object.fromEntries(
            items.map((item) => {
              const skuId = skuNameToId[item.sku];
              return [item.sku, skuId ? (stockBySkuId[skuId] ?? 0) : 0];
            }),
          );

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
            preferredCenter:
              (r.fulfillment_centers ?? []).length > 0
                ? (r.fulfillment_centers ?? []).map((center) => center.center_name).join(", ")
                : "Awaiting stock mapping",
            referredBy: r.reference_name || "Not provided",
            submittedDate: r.created_at.slice(0, 10),
            daysWaiting,
            status,
            reviewedDate: status === "Pending" ? undefined : r.updated_at.slice(0, 10),
            rejectionReason: r.rejection_reason ?? undefined,
            notes: r.notes ?? undefined,
            expectedDuration: r.expected_duration ?? undefined,
            availability,
          };
        });

        setPending(mapped.filter((r) => r.status === "Pending"));
        setApproved(mapped.filter((r) => r.status === "Approved"));
        setReviewed(mapped.filter((r) => r.status !== "Pending"));
        setRejected(mapped.filter((r) => r.status === "Rejected"));
      } catch {
        toast.error("Could not load approvals");
      }
    }
    loadData();
  }, []);

  const handleApprove = async (req: ApprovalRequest, e: React.MouseEvent) => {
    // Approves one pending request and moves it to reviewed list locally.
    e.stopPropagation();
    try {
      await apiFetch(`/api/v1/lease-requests/${req.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "approved" }),
      });
    } catch {
      toast.error(`Failed to approve ${req.token}`);
      return;
    }
    setPending((p) => p.filter((r) => r.id !== req.id));
    const updatedRequest = { ...req, status: "Approved" as const, reviewedDate: new Date().toISOString().split("T")[0], daysWaiting: 0 };
    setApproved((r) => [updatedRequest, ...r]);
    setReviewed((r) => [updatedRequest, ...r.filter((item) => item.id !== req.id)]);
    toast.success(`Request ${req.token} approved`);
  };

  const handleRejectOpen = (id: string, e: React.MouseEvent) => {
    // Opens rejection modal for the selected request.
    e.stopPropagation();
    setRejectId(id);
    setRejectReason("");
  };

  const handleRejectConfirm = async () => {
    // Persists rejection reason and updates reviewed list.
    const req = pending.find((r) => r.id === rejectId);
    if (!req) return;
    try {
      await apiFetch(`/api/v1/lease-requests/${req.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "rejected", rejection_reason: rejectReason }),
      });
    } catch {
      toast.error(`Failed to reject ${req.token}`);
      return;
    }
    setPending((p) => p.filter((r) => r.id !== rejectId));
    const updatedRequest = { ...req, status: "Rejected" as const, reviewedDate: new Date().toISOString().split("T")[0], daysWaiting: 0, rejectionReason: rejectReason };
    setRejected((r) => [updatedRequest, ...r]);
    setReviewed((r) => [updatedRequest, ...r.filter((item) => item.id !== req.id)]);
    toast.error(`Request ${req.token} rejected`);
    setRejectId(null);
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
    setPending((p) =>
      p.map((r) =>
        r.id === editReq.id
          ? { ...r, items: editItems, notes: updatedNotes }
          : r
      )
    );
    toast.success(`Request ${editReq.token} updated`);
    setEditReq(null);
  };

  const updateEditItemQty = (index: number, qty: number) => {
    // Enforces a minimum quantity of 1 while editing request items.
    setEditItems((items) => items.map((item, i) => i === index ? { ...item, qty: Math.max(1, qty) } : item));
  };

  const approvedSorted = useMemo(() => approved, [approved]);
  const reviewedSorted = useMemo(() => reviewed, [reviewed]);
  const rejectedSorted = useMemo(() => rejected, [rejected]);

  const reviewedBadgeClass = (status: ApprovalRequest["status"]) => {
    switch (status) {
      case "Approved":
        return "bg-success/15 text-success border-success/30";
      case "Active":
        return "bg-primary/10 text-primary border-primary/30";
      case "Closed":
        return "bg-muted text-muted-foreground border-border";
      default:
        return "bg-destructive/15 text-destructive border-destructive/30";
    }
  };

  const renderCard = (req: ApprovalRequest, isPending: boolean) => (
    // Shared card renderer for pending and reviewed tabs.
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

        {isPending && (
          <div className="flex flex-wrap gap-2 pt-1">
            {can("requests.approve") && (
              <Button size="sm" className="bg-success hover:bg-success/90 text-success-foreground gap-1" onClick={(e) => handleApprove(req, e)}>
                <CheckCircle className="h-3.5 w-3.5" /> Approve
              </Button>
            )}
            {can("requests.reject") && (
              <Button size="sm" variant="outline" className="border-destructive text-destructive hover:bg-destructive/10 gap-1" onClick={(e) => handleRejectOpen(req.id, e)}>
                <XCircle className="h-3.5 w-3.5" /> Reject
              </Button>
            )}
            {can("requests.edit") && (
              <Button size="sm" variant="outline" className="gap-1 ml-auto" onClick={(e) => handleEditOpen(req, e)}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-4">
      <Tabs value={currentTab} onValueChange={(v) => setSearchParams({ tab: v })}>
        <TabsList>
          <TabsTrigger value="pending" className="gap-1"><Clock className="h-3.5 w-3.5" /> Pending ({pending.length})</TabsTrigger>
          <TabsTrigger value="approved" className="gap-1"><CheckCircle className="h-3.5 w-3.5" /> Approved ({approved.length})</TabsTrigger>
          <TabsTrigger value="reviewed" className="gap-1"><FolderCheck className="h-3.5 w-3.5" /> Reviewed ({reviewed.length})</TabsTrigger>
          <TabsTrigger value="rejected" className="gap-1"><XCircle className="h-3.5 w-3.5" /> Rejected ({rejected.length})</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {currentTab === "pending" && pending.map((r) => renderCard(r, true))}
        {currentTab === "approved" && approvedSorted.map((r) => renderCard(r, false))}
        {currentTab === "reviewed" && reviewedSorted.map((r) => renderCard(r, false))}
        {currentTab === "rejected" && rejectedSorted.map((r) => renderCard(r, false))}
      </div>

      {currentTab === "pending" && pending.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <CheckCircle className="h-12 w-12 mx-auto mb-3 text-success" />
          <p className="text-lg font-medium">All caught up!</p>
          <p className="text-sm">No pending approvals</p>
        </div>
      )}

      {currentTab === "approved" && approved.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <CheckCircle className="h-12 w-12 mx-auto mb-3 text-success" />
          <p className="text-lg font-medium">No approved requests</p>
          <p className="text-sm">Approved requests will appear here</p>
        </div>
      )}

      {currentTab === "reviewed" && reviewed.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <FolderCheck className="h-12 w-12 mx-auto mb-3 text-primary" />
          <p className="text-lg font-medium">No reviewed requests</p>
          <p className="text-sm">Reviewed tokens will appear here</p>
        </div>
      )}

      {currentTab === "rejected" && rejected.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <XCircle className="h-12 w-12 mx-auto mb-3 text-destructive" />
          <p className="text-lg font-medium">No rejected requests</p>
          <p className="text-sm">Rejected requests will appear here</p>
        </div>
      )}

      {/* Reject Dialog */}
      <Dialog open={!!rejectId} onOpenChange={() => setRejectId(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Reject Request</DialogTitle></DialogHeader>
          <Textarea placeholder="Reason for rejection (min 20 characters)..." value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={4} />
          <p className="text-xs text-muted-foreground">{rejectReason.length}/20 characters minimum</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectId(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleRejectConfirm} disabled={rejectReason.length < 20}>Submit Rejection</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
              <Label className="text-sm font-medium">Reason for edit *</Label>
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
    default:
      return "Pending";
  }
}
