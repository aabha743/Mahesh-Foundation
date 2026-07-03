import { useEffect, useMemo, useState } from "react";
import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { CheckCircle, Clock, XCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { listLeaseExtensions, reviewLeaseExtension, type LeaseExtension } from "@/lib/api";
import { toast } from "sonner";

const tabs = ["pending", "approved", "rejected"] as const;

export default function LeaseExtensionsReview() {
  const [extensions, setExtensions] = useState<LeaseExtension[]>([]);
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("pending");
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<LeaseExtension | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  useEffect(() => {
    void loadExtensions();
  }, []);

  async function loadExtensions() {
    try {
      setExtensions(await listLeaseExtensions());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load extension requests");
    }
  }

  async function handleApprove(extension: LeaseExtension) {
    setSubmittingId(extension.id);
    try {
      const updated = await reviewLeaseExtension(extension.id, {
        status: "approved",
        approver_comments: "Requested due date approved after review",
      });
      setExtensions((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      toast.success(`Approved extension for ${extension.token_number}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not approve extension");
    } finally {
      setSubmittingId(null);
    }
  }

  async function handleRejectConfirm() {
    if (!rejectTarget) return;
    setSubmittingId(rejectTarget.id);
    try {
      const updated = await reviewLeaseExtension(rejectTarget.id, {
        status: "rejected",
        rejection_reason: rejectReason.trim(),
      });
      setExtensions((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      toast.success(`Rejected extension for ${rejectTarget.token_number}`);
      setRejectTarget(null);
      setRejectReason("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not reject extension");
    } finally {
      setSubmittingId(null);
    }
  }

  const filtered = useMemo(
    () => extensions.filter((extension) => extension.status === activeTab),
    [activeTab, extensions],
  );

  return (
    <div className="space-y-4">
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as (typeof tabs)[number])}>
        <TabsList>
          <TabsTrigger value="pending">Pending ({extensions.filter((item) => item.status === "pending").length})</TabsTrigger>
          <TabsTrigger value="approved">Approved ({extensions.filter((item) => item.status === "approved").length})</TabsTrigger>
          <TabsTrigger value="rejected">Rejected ({extensions.filter((item) => item.status === "rejected").length})</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {filtered.map((extension) => {
          const currentDue = format(parseISO(extension.current_due_date), "dd MMM yyyy");
          const requestedDue = extension.requested_due_date ? format(parseISO(extension.requested_due_date), "dd MMM yyyy") : extension.requested_duration;
          const approvedDue = extension.approved_due_date ? format(parseISO(extension.approved_due_date), "dd MMM yyyy") : null;
          const requestedDiff = extension.requested_due_date
            ? differenceInCalendarDays(parseISO(extension.requested_due_date), parseISO(extension.current_due_date))
            : extension.requested_days;
          return (
            <Card key={extension.id}>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="font-mono font-semibold text-foreground">{extension.token_number}</p>
                    <p className="text-sm text-muted-foreground">{extension.requestor_name}</p>
                  </div>
                  <Badge variant="outline" className="capitalize">{extension.status}</Badge>
                </div>

                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <p><span className="text-muted-foreground">Current due date:</span> {currentDue}</p>
                  <p><span className="text-muted-foreground">Requested due date:</span> {requestedDue}</p>
                  <p><span className="text-muted-foreground">Extra days:</span> {requestedDiff}</p>
                  <p><span className="text-muted-foreground">Mobile:</span> {extension.mobile}</p>
                </div>

                {extension.reason && (
                  <p className="text-sm text-muted-foreground rounded-md bg-muted/30 p-3">{extension.reason}</p>
                )}
                {approvedDue && (
                  <p className="text-sm text-success"><span className="text-muted-foreground">Approved due date:</span> {approvedDue}</p>
                )}
                {extension.rejection_reason && (
                  <p className="text-sm text-destructive"><span className="text-muted-foreground">Rejected because:</span> {extension.rejection_reason}</p>
                )}

                {extension.status === "pending" && (
                  <div className="flex gap-2 pt-1">
                    <Button
                      size="sm"
                      className="bg-success hover:bg-success/90 text-success-foreground gap-1"
                      onClick={() => void handleApprove(extension)}
                      disabled={submittingId === extension.id}
                    >
                      <CheckCircle className="h-3.5 w-3.5" />
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-destructive text-destructive hover:bg-destructive/10 gap-1"
                      onClick={() => {
                        setRejectTarget(extension);
                        setRejectReason("");
                      }}
                      disabled={submittingId === extension.id}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      Reject
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <Clock className="h-12 w-12 mx-auto mb-3 text-primary" />
          <p className="text-lg font-medium capitalize">No {activeTab} extension requests</p>
          <p className="text-sm">Requests will appear here once they are submitted.</p>
        </div>
      )}

      <Dialog open={!!rejectTarget} onOpenChange={(open) => !open && setRejectTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject extension request</DialogTitle>
            <DialogDescription>
              {rejectTarget ? `Provide a reason for rejecting the extension request for token ${rejectTarget.token_number}.` : ""}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={4}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Reason for rejection"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)} disabled={submittingId === rejectTarget?.id}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleRejectConfirm()}
              disabled={!rejectReason.trim() || submittingId === rejectTarget?.id}
            >
              Reject request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
