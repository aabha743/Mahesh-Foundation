import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, CheckCircle, XCircle, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { type ApprovalRequest } from "@/data/approverMockData";
import { apiFetch } from "@/lib/api";
import { formatLeaseStatus } from "@/lib/utils";

export default function ApprovalDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [showApproveConfirm, setShowApproveConfirm] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showEditModal, setShowEditModal] = useState(false);
  const [editItems, setEditItems] = useState<{ sku: string; qty: number }[]>([]);
  const [editComment, setEditComment] = useState("");
  const [skuNameToIdMap, setSkuNameToIdMap] = useState<Record<string, string>>({});

  useEffect(() => {
    // Loads a single approval request with SKU availability and fulfillment-center hints.
    async function loadRequest() {
      try {
        const [requests, skus] = await Promise.all([
          apiFetch<Array<{
            id: string;
            token_number: string;
            requestor_name: string;
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

        const row = requests.find((r) => r.id === id);
        if (!row) {
          setRequest(null);
          return;
        }
        const skuInventory = await apiFetch<Array<{ sku_id: string; status: string }>>("/api/v1/assets");
        const stockBySkuId: Record<string, number> = {};
        skuInventory.forEach((a) => {
          if (a.status !== "available") return;
          stockBySkuId[a.sku_id] = (stockBySkuId[a.sku_id] ?? 0) + 1;
        });
        const skuNameToId = Object.fromEntries(skus.map((s) => [s.name, s.id]));
        setSkuNameToIdMap(skuNameToId);
        const status = formatLeaseStatus(row.status) as ApprovalRequest["status"];
        const items = (row.items ?? []).length
          ? (row.items ?? []).map((item) => ({ sku: item.sku_name, qty: item.quantity_requested }))
          : (row.skus ?? []).map((sku) => ({ sku, qty: 1 }));
        const availability = Object.fromEntries(
          items.map((item) => {
            const skuId = skuNameToId[item.sku];
            return [item.sku, skuId ? (stockBySkuId[skuId] ?? 0) : 0];
          }),
        );

        setRequest({
          id: row.id,
          token: row.token_number,
          requestorName: row.requestor_name,
          mobile: row.mobile,
          aadhar: row.aadhar_number,
          items,
          preferredCenter:
            (row.fulfillment_centers ?? []).length > 0
              ? (row.fulfillment_centers ?? []).map((center) => center.center_name).join(", ")
              : "Awaiting stock mapping",
          referredBy: row.reference_name || "Not provided",
          submittedDate: row.created_at.slice(0, 10),
          daysWaiting: 0,
          status,
          reviewedDate: status === "Pending" ? undefined : row.updated_at.slice(0, 10),
          rejectionReason: row.rejection_reason ?? undefined,
          notes: row.notes ?? undefined,
          expectedDuration: row.expected_duration ?? undefined,
          availability,
        });
      } catch {
        setRequest(null);
      } finally {
        setLoading(false);
      }
    }
    loadRequest();
  }, [id]);

  if (loading) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Loading request...</p>
      </div>
    );
  }

  if (!request) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Request not found</p>
        <Button variant="link" onClick={() => navigate("/approvals")}>Back to Approvals</Button>
      </div>
    );
  }

  const isPending = request.status === "Pending";

  const handleApprove = async () => {
    // Approves this request and returns to approvals queue.
    try {
      await apiFetch(`/api/v1/lease-requests/${request.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "approved" }),
      });
    } catch {
      toast.error(`Failed to approve ${request.token}`);
      return;
    }
    toast.success(`Request ${request.token} approved`);
    navigate("/approvals");
  };

  const handleReject = async () => {
    // Rejects this request with the entered reason.
    try {
      await apiFetch(`/api/v1/lease-requests/${request.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "rejected", rejection_reason: rejectReason }),
      });
    } catch {
      toast.error(`Failed to reject ${request.token}`);
      return;
    }
    toast.error(`Request ${request.token} rejected`);
    navigate("/approvals");
  };

  const handleEditOpen = () => {
    // Opens edit modal with a copy of current request items.
    setEditItems(request.items.map((i) => ({ ...i })));
    setEditComment("");
    setShowEditModal(true);
  };

  const handleEditSave = async () => {
    // Saves item edits and appends approver edit reason to notes.
    if (!editComment.trim()) return;
    const noteToAppend = `[Approver Edit] ${editComment}`;
    const updatedNotes = (request.notes ? `${request.notes}\n` : "") + noteToAppend;
    const itemPayload = editItems.map((item) => {
      const skuId = skuNameToIdMap[item.sku];
      return { sku_id: skuId, quantity_requested: item.qty };
    });
    if (itemPayload.some((item) => !item.sku_id)) {
      toast.error("Could not map one or more SKUs to IDs");
      return;
    }
    try {
      await apiFetch(`/api/v1/lease-requests/${request.id}`, {
        method: "PATCH",
        body: JSON.stringify({ notes: updatedNotes, items: itemPayload }),
      });
    } catch {
      toast.error(`Failed to update ${request.token}`);
      return;
    }
    setRequest({
      ...request,
      items: editItems,
      notes: updatedNotes,
    });
    toast.success(`Request ${request.token} updated`);
    setShowEditModal(false);
  };

  const updateEditItemQty = (index: number, qty: number) => {
    // Applies bounded item quantity edits (minimum 1).
    setEditItems((items) => items.map((item, i) => i === index ? { ...item, qty: Math.max(1, qty) } : item));
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <button onClick={() => navigate("/approvals")} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to Approvals
      </button>

      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-bold font-mono text-foreground">{request.token}</h2>
          <p className="text-sm text-muted-foreground">Submitted {request.submittedDate}</p>
        </div>
        <Badge variant="outline" className={
          request.status === "Approved" ? "bg-success/15 text-success border-success/30" :
          request.status === "Rejected" ? "bg-destructive/15 text-destructive border-destructive/30" :
          "bg-warning/15 text-warning border-warning/30"
        }>{request.status}</Badge>
      </div>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Requestor Details</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <div><span className="text-muted-foreground">Name</span><p className="font-medium">{request.requestorName}</p></div>
            <div><span className="text-muted-foreground">Mobile</span><p className="font-medium">{request.mobile}</p></div>
            <div><span className="text-muted-foreground">Aadhar</span><p className="font-medium">{request.aadhar}</p></div>
          </div>
          <p className="text-sm mt-3 italic text-muted-foreground">Referred by: {request.referredBy}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Requested Devices</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
          <Table className="min-w-[420px]">
            <TableHeader>
              <TableRow><TableHead>SKU Name</TableHead><TableHead>Qty</TableHead><TableHead>Availability</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {request.items.map((item, index) => {
                const avail = request.availability?.[item.sku] ?? 0;
                const sufficient = avail >= item.qty;
                return (
                  <TableRow key={`${item.sku}-${index}`}>
                    <TableCell>{item.sku}</TableCell>
                    <TableCell>{item.qty}</TableCell>
                    <TableCell>
                      <span className={sufficient ? "text-success font-medium" : "text-destructive font-medium"}>
                        {avail} in stock
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Fulfillment & Notes</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-2">
          <p><span className="text-muted-foreground">Pickup center(s):</span> <Badge variant="outline">{request.preferredCenter}</Badge></p>
          {request.expectedDuration && <p><span className="text-muted-foreground">Expected Duration:</span> {request.expectedDuration}</p>}
          {request.notes && (
            <div className="bg-muted p-3 rounded-lg text-sm whitespace-pre-line">
              <p className="text-xs font-medium text-muted-foreground mb-1">Notes / Edit History</p>
              {request.notes}
            </div>
          )}
          {request.rejectionReason && <p className="text-destructive bg-destructive/5 p-3 rounded-lg">{request.rejectionReason}</p>}
        </CardContent>
      </Card>

      {isPending && (
        <div className="sticky bottom-0 bg-card border-t border-border p-4 -mx-4 lg:-mx-6 flex flex-col sm:flex-row gap-3">
          <Button className="flex-1 bg-success hover:bg-success/90 text-success-foreground h-11 gap-1" onClick={() => setShowApproveConfirm(true)}>
            <CheckCircle className="h-4 w-4" /> Approve
          </Button>
          <Button variant="outline" className="flex-1 h-11 gap-1" onClick={handleEditOpen}>
            <Pencil className="h-4 w-4" /> Edit
          </Button>
          <Button variant="destructive" className="flex-1 h-11 gap-1" onClick={() => setShowRejectModal(true)}>
            <XCircle className="h-4 w-4" /> Reject
          </Button>
        </div>
      )}

      <AlertDialog open={showApproveConfirm} onOpenChange={setShowApproveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve this request?</AlertDialogTitle>
            <AlertDialogDescription>This will approve lease request {request.token} for {request.requestorName}.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-success hover:bg-success/90" onClick={handleApprove}>Approve</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={showRejectModal} onOpenChange={setShowRejectModal}>
        <DialogContent>
          <DialogHeader><DialogTitle>Reason for Rejection</DialogTitle></DialogHeader>
          <Textarea placeholder="Enter rejection reason (min 20 characters)..." value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={4} />
          <p className="text-xs text-muted-foreground">{rejectReason.length}/20 characters minimum</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRejectModal(false)}>Cancel</Button>
            <Button variant="destructive" disabled={rejectReason.length < 20} onClick={handleReject}>Submit Rejection</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={showEditModal} onOpenChange={setShowEditModal}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Edit Request — {request.token}</DialogTitle></DialogHeader>
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
            <Button variant="outline" onClick={() => setShowEditModal(false)}>Cancel</Button>
            <Button onClick={handleEditSave} disabled={!editComment.trim()}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
