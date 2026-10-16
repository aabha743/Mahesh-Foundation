import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle, Eye, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import TokenDetailDialog from "@/components/lease/TokenDetailDialog";
import { awaitsDecision, formatFulfillmentCenterLabel, leaseStatusColors } from "@/lib/leaseRequestDisplay";
import { type LeaseRequestView as LeaseRequest, type LeaseStatus } from "@/lib/uiTypes";
import { formatLeaseStatus } from "@/lib/utils";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";

const tabs = ["All", "Pending", "Approved", "Expired", "Active", "Closed"] as const;

export default function LeaseRequestsPage() {
  const { activeRole, can, hasRole } = useAuth();
  const [activeTab, setActiveTab] = useState("All");
  const [viewRequest, setViewRequest] = useState<LeaseRequest | null>(null);
  const [leaseRequests, setLeaseRequests] = useState<LeaseRequest[]>([]);
  const [submittingAction, setSubmittingAction] = useState(false);
  const [rejectRequest, setRejectRequest] = useState<LeaseRequest | null>(null);
  const [rejectReason, setRejectReason] = useState("");


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

  const refreshAfterMutation = useCallback(
    async (request: LeaseRequest) => {
      const latest = await reloadLeaseRequests();
      const updated = latest.find((item) => item.id === request.id) ?? null;
      // A new object for the open request makes the token dialog reload its activity.
      if (updated) {
        setViewRequest(updated);
      }
    },
    [reloadLeaseRequests],
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
                    <Badge variant="outline" className={cn("border", leaseStatusColors[req.status])}>{req.status}</Badge>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell text-muted-foreground">{req.submittedDate}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {canUseAdminFallback && awaitsDecision(req.status) && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-success hover:text-success"
                            onClick={() => void handleApprove(req)}
                            disabled={submittingAction}
                            title={req.status === "Expired" ? "Re-approve expired request" : "Approve pending request"}
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
                            title={req.status === "Expired" ? "Reject expired request" : "Reject pending request"}
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
                  <Badge variant="outline" className={cn("border", leaseStatusColors[req.status])}>{req.status}</Badge>
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
                  {canUseAdminFallback && awaitsDecision(req.status) && (
                    <>
                      <Button size="sm" className="w-full justify-start bg-success hover:bg-success/90 text-success-foreground" onClick={() => void handleApprove(req)} disabled={submittingAction}>
                        <CheckCircle className="h-4 w-4 mr-2" />
                        {req.status === "Expired" ? "Re-approve" : "Approve"}
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

      <TokenDetailDialog
        request={viewRequest}
        onClose={() => setViewRequest(null)}
        canDecide={canUseAdminFallback}
        submitting={submittingAction}
        onApprove={(request) => void handleApprove(request)}
        onReject={(request) => {
          setRejectRequest(request);
          setRejectReason("");
        }}
      />

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
