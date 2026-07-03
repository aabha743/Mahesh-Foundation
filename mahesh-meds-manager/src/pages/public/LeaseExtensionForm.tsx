import { useEffect, useMemo, useState } from "react";
import { format, isAfter, isFuture, parseISO } from "date-fns";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, CalendarClock } from "lucide-react";
import { PublicFooter, PublicHeader } from "@/components/PublicHeader";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { createLeaseExtension, getLeaseRequestByToken, type LeaseRequestTokenLookup } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export default function LeaseExtensionForm() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialToken = (searchParams.get("token") ?? "").toUpperCase();
  const [tokenNumber, setTokenNumber] = useState(initialToken);
  const [requestorName, setRequestorName] = useState("");
  const [mobile, setMobile] = useState("");
  const [aadharNumber, setAadharNumber] = useState("");
  const [requestedReturnDate, setRequestedReturnDate] = useState<Date | undefined>(undefined);
  const [reason, setReason] = useState("");
  const [tokenContext, setTokenContext] = useState<LeaseRequestTokenLookup | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!initialToken) return;
    void lookupToken(initialToken);
  }, [initialToken]);

  const currentDueDate = useMemo(
    () => (tokenContext?.due_date ? parseISO(tokenContext.due_date) : null),
    [tokenContext?.due_date],
  );

  async function lookupToken(token: string) {
    if (!token.trim()) return;
    setLookupLoading(true);
    try {
      const lease = await getLeaseRequestByToken(token.trim());
      setTokenContext(lease);
      setTokenNumber(lease.token_number);
      setRequestorName(lease.requestor_name);
      setMobile(/\D/.test(lease.mobile) ? "" : lease.mobile);
      setAadharNumber(/\D/.test(lease.aadhar_number) ? "" : lease.aadhar_number);
      setRequestedReturnDate(undefined);
    } catch (error) {
      setTokenContext(null);
      toast.error(error instanceof Error ? error.message : "Could not validate token");
    } finally {
      setLookupLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!requestedReturnDate) {
      toast.error("Please choose a requested return date");
      return;
    }
    if (!currentDueDate) {
      toast.error("This token does not have a current due date yet");
      return;
    }
    if (!isAfter(requestedReturnDate, currentDueDate)) {
      toast.error("Requested return date must be after the current due date");
      return;
    }
    if (!isFuture(requestedReturnDate)) {
      toast.error("Requested return date must be in the future");
      return;
    }

    setSubmitting(true);
    try {
      await createLeaseExtension({
        token_number: tokenNumber.trim(),
        requestor_name: requestorName.trim(),
        mobile: mobile.trim(),
        aadhar_number: aadharNumber.trim(),
        requested_due_date: format(requestedReturnDate, "yyyy-MM-dd"),
        reason: reason.trim() || undefined,
      });
      toast.success("Extension request submitted. You will be notified once reviewed.");
      navigate(`/status?token=${encodeURIComponent(tokenNumber.trim())}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not submit extension request";
      toast.error(
        message.includes("pending")
          ? "You already have a pending extension request for this token."
          : message,
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <PublicHeader />
      <main className="flex-1 max-w-2xl mx-auto w-full px-4 py-8 space-y-6">
        <div className="space-y-2">
          <Link to="/status" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
            Back to token tracking
          </Link>
          <h2 className="text-2xl font-bold text-foreground">Request Lease Extension</h2>
          <p className="text-muted-foreground">
            We’ll validate your active token first, then send the requested return date for approver review.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Validate Token</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input
                value={tokenNumber}
                onChange={(e) => setTokenNumber(e.target.value.toUpperCase())}
                placeholder="Enter token number"
                className="font-mono"
              />
              <Button type="button" variant="secondary" onClick={() => void lookupToken(tokenNumber)} disabled={lookupLoading}>
                {lookupLoading ? "Checking..." : "Check Token"}
              </Button>
            </div>

            {tokenContext && (
              <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-2">
                <div className="flex items-center gap-2 font-medium text-foreground">
                  <CalendarClock className="h-4 w-4 text-primary" />
                  Current due date: {tokenContext.due_date ? format(parseISO(tokenContext.due_date), "dd MMM yyyy") : "Not set"}
                </div>
                <p className={tokenContext.extension_eligible ? "text-success" : "text-muted-foreground"}>
                  {tokenContext.extension_eligibility_reason ?? "Eligibility will be checked again on submit."}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Extension Request Details</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={(e) => void handleSubmit(e)}>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="requestor-name">Requestor name</Label>
                  <Input id="requestor-name" value={requestorName} onChange={(e) => setRequestorName(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mobile">Mobile</Label>
                  <Input id="mobile" value={mobile} onChange={(e) => setMobile(e.target.value.replace(/\D/g, "").slice(0, 10))} />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="aadhar">Aadhaar</Label>
                  <Input id="aadhar" value={aadharNumber} onChange={(e) => setAadharNumber(e.target.value.replace(/\D/g, "").slice(0, 12))} />
                </div>
                <div className="space-y-2">
                  <Label>Requested return date</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        className={cn("w-full justify-start text-left font-normal", !requestedReturnDate && "text-muted-foreground")}
                      >
                        {requestedReturnDate ? format(requestedReturnDate, "dd MMM yyyy") : "Choose requested return date"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={requestedReturnDate}
                        onSelect={setRequestedReturnDate}
                        disabled={(date) =>
                          !isFuture(date) || (currentDueDate ? !isAfter(date, currentDueDate) : false)
                        }
                        initialFocus
                        className="p-3 pointer-events-auto"
                      />
                    </PopoverContent>
                  </Popover>
                  <p className="text-xs text-muted-foreground">
                    Choose a future date after the current due date.
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="reason">Reason</Label>
                <Textarea
                  id="reason"
                  rows={4}
                  placeholder="Tell us why you need more time with the device."
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>

              <div className="flex items-center justify-between gap-3 pt-2">
                <p className="text-xs text-muted-foreground">
                  Submission will be checked again against the original token, mobile, Aadhaar, and current lease eligibility.
                </p>
                <Button type="submit" disabled={submitting || (tokenContext !== null && !tokenContext.extension_eligible)}>
                  {submitting ? "Submitting..." : "Submit Extension Request"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </main>
      <PublicFooter />
    </div>
  );
}
