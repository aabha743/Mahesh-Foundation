import { useEffect, useMemo, useState } from "react";
import { format, isAfter, isFuture, parseISO, addDays, differenceInCalendarDays } from "date-fns";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, CalendarClock } from "lucide-react";
import { PublicFooter, PublicHeader } from "@/components/PublicHeader";
import { TrackOtpStep } from "@/components/TrackOtpStep";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { createLeaseExtension, getLeaseRequestByToken, needsOtp, type LeaseRequestTokenLookup } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { RequiredMark } from "@/components/RequiredMark";

export default function LeaseExtensionForm() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialToken = (searchParams.get("token") ?? "").toUpperCase();
  const [tokenNumber, setTokenNumber] = useState(initialToken);
  const [requestedReturnDate, setRequestedReturnDate] = useState<Date | undefined>(undefined);
  const [reason, setReason] = useState("");
  const [tokenContext, setTokenContext] = useState<LeaseRequestTokenLookup | null>(null);
  // The token waiting for OTP verification of its mobile number before the lease can be shown.
  const [otpFor, setOtpFor] = useState<string | null>(null);
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
    setOtpFor(null);
    try {
      const lease = await getLeaseRequestByToken(token.trim());
      setTokenContext(lease);
      setTokenNumber(lease.token_number);
      setRequestedReturnDate(undefined);
    } catch (error) {
      setTokenContext(null);
      if (needsOtp(error)) {
        setOtpFor(token.trim());
      } else {
        toast.error(error instanceof Error ? error.message : "Could not validate token");
      }
    } finally {
      setLookupLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!tokenContext) {
      toast.error("Please check and verify your token first");
      return;
    }
    if (!requestedReturnDate) {
      toast.error("Please choose a requested return date");
      return;
    }
    if (!reason.trim()) {
      toast.error("Please provide a reason for the extension");
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
    if (differenceInCalendarDays(requestedReturnDate, currentDueDate) > 14) {
      toast.error("Extension request cannot exceed 2 weeks from the current due date");
      return;
    }

    setSubmitting(true);
    try {
      await createLeaseExtension({
        token_number: tokenContext.token_number,
        requested_due_date: format(requestedReturnDate, "yyyy-MM-dd"),
        reason: reason.trim(),
      });
      toast.success("Extension request submitted. You will be notified once reviewed.");
      navigate(`/status?token=${encodeURIComponent(tokenContext.token_number)}`);
    } catch (error) {
      if (needsOtp(error)) {
        // The 30-minute verification ran out while filling in the form.
        toast.error("Your verification has expired. Please verify with a new OTP and submit again.");
        setOtpFor(tokenContext.token_number);
        return;
      }
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
            We'll verify your token with an OTP to the mobile number on the request, then send the requested return date
            for approver review.
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
                aria-label="Token number"
              />
              <Button type="button" variant="secondary" onClick={() => void lookupToken(tokenNumber)} disabled={lookupLoading}>
                {lookupLoading ? "Checking..." : "Check Token"}
              </Button>
            </div>

            {tokenContext && (
              <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-2">
                <p className="text-foreground">
                  <span className="text-muted-foreground">Requested by:</span> {tokenContext.requestor_name}{" "}
                  <span className="text-muted-foreground">({tokenContext.mobile})</span>
                </p>
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

        {otpFor && <TrackOtpStep query={otpFor} onVerified={() => void lookupToken(otpFor)} />}

        {tokenContext && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Extension Request Details</CardTitle>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={(e) => void handleSubmit(e)}>
                <div className="space-y-2">
                  <Label>Requested return date<RequiredMark /></Label>
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
                          !isFuture(date) ||
                          (currentDueDate
                            ? !isAfter(date, currentDueDate) || isAfter(date, addDays(currentDueDate, 14))
                            : false)
                        }
                        initialFocus
                        className="p-3 pointer-events-auto"
                      />
                    </PopoverContent>
                  </Popover>
                  <p className="text-xs text-muted-foreground">
                    Choose a date up to 2 weeks after the current due date.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="reason">Reason<RequiredMark /></Label>
                  <Textarea
                    id="reason"
                    rows={4}
                    placeholder="Tell us why you need more time with the device."
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>

                <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-muted-foreground">
                    Your request is checked again against the lease's current eligibility when you submit.
                  </p>
                  <Button type="submit" className="w-full sm:w-auto" disabled={submitting || !tokenContext.extension_eligible}>
                    {submitting ? "Submitting..." : "Submit Extension Request"}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}
      </main>
      <PublicFooter />
    </div>
  );
}
