import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArchiveRestore, CalendarClock, CheckCircle, Clock, Package, Search, XCircle } from "lucide-react";
import { format, formatDistanceToNow, parseISO } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PublicFooter, PublicHeader } from "@/components/PublicHeader";
import { apiFetch, getLeaseRequestByToken, getLeaseRequestsByMobile, type LeaseRequestTokenLookup } from "@/lib/api";
import { emergencyContactText } from "@/lib/brand";

type ExtensionHistoryEntry = {
  id: string;
  status: string;
  requestedDuration: string;
  requestedDays: number;
  requestedDueDate?: string | null;
  currentDueDate: string;
  approvedDueDate?: string | null;
  requestedAt: string;
  reviewedAt?: string | null;
  reason?: string | null;
  rejectionReason?: string | null;
};

type StatusResult = {
  token: string;
  status: "Pending" | "Approved" | "Rejected" | "Active" | "Closed";
  requestorName: string;
  mobile: string;
  dueDate?: string;
  fulfillmentMessage?: string;
  fulfillmentCenters: Array<{ centerId: string; centerName: string; itemNames: string[] }>;
  extensionEligible: boolean;
  extensionEligibilityReason?: string;
  pendingExtensionRequest: boolean;
  latestExtension?: { status: string; requestedDuration: string; requestedDueDate?: string | null; approvedDueDate?: string | null };
  extensionHistory: ExtensionHistoryEntry[];
  items: { sku: string; qty: number; serial?: string; dueDate?: string | null }[];
  preferredCenter: string;
  submittedDate: string;
  rejectionReason?: string;
  notes?: string;
};

type LookupMode = "token" | "mobile";

const statusConfig: Record<string, { icon: React.ReactNode; title: string; color: string; bg: string }> = {
  Pending: { icon: <Clock className="h-12 w-12 text-warning" />, title: "Under Review", color: "text-warning", bg: "bg-warning/10" },
  Approved: { icon: <CheckCircle className="h-12 w-12 text-success" />, title: "Request Approved!", color: "text-success", bg: "bg-success/10" },
  Rejected: { icon: <XCircle className="h-12 w-12 text-destructive" />, title: "Request Not Approved", color: "text-destructive", bg: "bg-destructive/10" },
  Active: { icon: <Package className="h-12 w-12 text-info" />, title: "Devices Currently With You", color: "text-info", bg: "bg-info/10" },
  Closed: { icon: <ArchiveRestore className="h-12 w-12 text-muted-foreground" />, title: "Loan Completed - Thank You", color: "text-muted-foreground", bg: "bg-muted" },
};

function dbStatusToUi(status: string): StatusResult["status"] {
  switch (status) {
    case "pending":
      return "Pending";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "active":
      return "Active";
    case "closed":
      return "Closed";
    default:
      return "Pending";
  }
}

function extensionStatusMeta(result: StatusResult) {
  if (!result.latestExtension) return null;

  if (result.latestExtension.status === "pending") {
    return {
      badge: "Pending Review",
      badgeClass: "bg-warning/10 text-warning border-warning/20",
      title: "Extension request submitted",
      body: result.latestExtension.requestedDueDate
        ? `Your request to return the device on ${format(parseISO(result.latestExtension.requestedDueDate), "dd MMM yyyy")} is under approver review.`
        : `Your ${result.latestExtension.requestedDuration} extension request is under approver review.`,
    };
  }

  if (result.latestExtension.status === "approved") {
    return {
      badge: "Approved",
      badgeClass: "bg-success/10 text-success border-success/20",
      title: "Lease extended",
      body: result.latestExtension.approvedDueDate
        ? `Your lease has been extended. New due date: ${format(parseISO(result.latestExtension.approvedDueDate), "dd MMM yyyy")}.`
        : `Your ${result.latestExtension.requestedDuration} extension request was approved.`,
    };
  }

  return {
    badge: "Rejected",
    badgeClass: "bg-destructive/10 text-destructive border-destructive/20",
    title: "Extension request not approved",
    body: result.latestExtension.requestedDueDate
      ? `Your request to move the due date to ${format(parseISO(result.latestExtension.requestedDueDate), "dd MMM yyyy")} was not approved.`
      : `Your last ${result.latestExtension.requestedDuration} extension request was not approved.`,
  };
}

function normalizeMobileLookup(value: string): string | null {
  let digitsOnly = value.replace(/\D/g, "");
  if (digitsOnly.length === 12 && digitsOnly.startsWith("91")) {
    digitsOnly = digitsOnly.slice(2);
  } else if (digitsOnly.length === 11 && digitsOnly.startsWith("0")) {
    digitsOnly = digitsOnly.slice(1);
  }
  return /^\d{10}$/.test(digitsOnly) ? digitsOnly : null;
}

function inferLookupMode(value: string): LookupMode {
  return normalizeMobileLookup(value) ? "mobile" : "token";
}

function mapLeaseLookupToStatusResult(
  data: LeaseRequestTokenLookup,
  centerMap: Record<string, string>,
): StatusResult {
  return {
    token: data.token_number,
    status: dbStatusToUi(data.status),
    requestorName: data.requestor_name,
    mobile: data.mobile,
    dueDate: data.due_date ?? undefined,
    fulfillmentMessage: data.fulfillment_message ?? undefined,
    fulfillmentCenters: (data.fulfillment_centers ?? []).map((center) => ({
      centerId: center.center_id,
      centerName: center.center_name,
      itemNames: center.item_names,
    })),
    extensionEligible: data.extension_eligible,
    extensionEligibilityReason: data.extension_eligibility_reason ?? undefined,
    pendingExtensionRequest: data.pending_extension_request,
    latestExtension: data.latest_extension
      ? {
          status: data.latest_extension.status,
          requestedDuration: data.latest_extension.requested_duration,
          requestedDueDate: data.latest_extension.requested_due_date,
          approvedDueDate: data.latest_extension.approved_due_date,
        }
      : undefined,
    extensionHistory: (data.extension_history ?? []).map((entry) => ({
      id: entry.id,
      status: entry.status,
      requestedDuration: entry.requested_duration,
      requestedDays: entry.requested_days,
      requestedDueDate: entry.requested_due_date,
      currentDueDate: entry.current_due_date,
      approvedDueDate: entry.approved_due_date,
      requestedAt: entry.requested_at,
      reviewedAt: entry.reviewed_at,
      reason: entry.reason,
      rejectionReason: entry.rejection_reason,
    })),
    items: (data.items ?? []).length
      ? (data.items ?? []).map((item) => ({
          sku: item.sku_name,
          qty: item.quantity_requested,
          dueDate: item.due_date,
        }))
      : (data.skus ?? []).map((sku) => ({ sku, qty: 1 })),
    preferredCenter: data.preferred_center_id ? centerMap[data.preferred_center_id] ?? "Unassigned" : "Unassigned",
    submittedDate: data.created_at.slice(0, 10),
    rejectionReason: data.rejection_reason ?? undefined,
    notes: data.notes ?? undefined,
  };
}

export default function RequestStatus() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("token") || searchParams.get("mobile") || "");
  const [result, setResult] = useState<StatusResult | null>(null);
  const [matches, setMatches] = useState<StatusResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lastLookupMode, setLastLookupMode] = useState<LookupMode>("token");

  useEffect(() => {
    const tokenParam = searchParams.get("token");
    const mobileParam = searchParams.get("mobile");
    const initialQuery = tokenParam || mobileParam || "";
    if (initialQuery) {
      setQuery(initialQuery);
      void doSearch(initialQuery);
    }
  }, [searchParams]);

  async function doSearch(nextQuery: string) {
    if (!nextQuery.trim()) return;
    const normalizedQuery = nextQuery.trim();
    const lookupMode = inferLookupMode(normalizedQuery);
    setSearched(true);
    setLoading(true);
    setLastLookupMode(lookupMode);
    try {
      const centers = await apiFetch<Array<{ id: string; name: string }>>("/api/v1/centers");
      const centerMap = Object.fromEntries(centers.map((center) => [center.id, center.name]));
      if (lookupMode === "mobile") {
        const normalizedMobile = normalizeMobileLookup(normalizedQuery);
        if (!normalizedMobile) {
          throw new Error("Enter a valid 10-digit mobile number");
        }
        const data = await getLeaseRequestsByMobile(normalizedMobile);
        const mapped = data.map((entry) => mapLeaseLookupToStatusResult(entry, centerMap));
        setMatches(mapped);
        setResult(mapped[0] ?? null);
      } else {
        const data = await getLeaseRequestByToken(normalizedQuery);
        const mapped = mapLeaseLookupToStatusResult(data, centerMap);
        setMatches([mapped]);
        setResult(mapped);
      }
    } catch {
      setMatches([]);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  const cfg = result ? statusConfig[result.status] : null;
  const extensionMeta = result ? extensionStatusMeta(result) : null;
  const canRequestExtension =
    !!result &&
    result.status === "Active" &&
    result.extensionEligible &&
    !result.pendingExtensionRequest &&
    (!result.latestExtension || result.latestExtension.status === "rejected");

  const latestHistory = useMemo(
    () => result?.extensionHistory ?? [],
    [result?.extensionHistory],
  );

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <PublicHeader />
      <main className="flex-1 max-w-3xl mx-auto w-full px-4 py-8 md:px-6 space-y-6">
        <div className="text-center space-y-1">
          <h2 className="text-xl md:text-2xl font-bold text-foreground">Track Your Request</h2>
          <p className="text-muted-foreground">Enter your token number or 10-digit mobile number to check status</p>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value.toUpperCase())}
            placeholder="Enter token or mobile number"
            className={inferLookupMode(query) === "mobile" ? "" : "font-mono"}
          />
          <Button onClick={() => void doSearch(query)} className="gap-1 w-full sm:w-auto min-h-12" disabled={loading}>
            <Search className="h-4 w-4" />
            {loading ? "Tracking..." : "Track"}
          </Button>
        </div>

        {searched && !result && (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              {lastLookupMode === "mobile"
                ? "No requests found with this mobile number. Please check and try again."
                : "No request found with this token. Please check and try again."}
            </CardContent>
          </Card>
        )}

        {matches.length > 1 && (
          <Card>
            <CardContent className="py-5 space-y-3">
              <div className="space-y-1">
                <p className="font-medium text-foreground">Requests linked to {matches[0]?.mobile}</p>
                <p className="text-sm text-muted-foreground">
                  We found {matches.length} requests for this mobile number. Choose one to view full details.
                </p>
              </div>
              <div className="space-y-2">
                {matches.map((match) => {
                  const isSelected = result?.token === match.token;
                  return (
                    <button
                      key={match.token}
                      type="button"
                      onClick={() => setResult(match)}
                      className={`w-full rounded-lg border px-4 py-3 text-left transition ${
                        isSelected ? "border-primary bg-primary/5" : "bg-card hover:bg-muted/40"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div>
                          <p className="font-mono text-sm font-semibold text-foreground">{match.token}</p>
                          <p className="text-sm text-muted-foreground">
                            {match.requestorName} â€¢ Submitted {format(parseISO(match.submittedDate), "dd MMM yyyy")}
                          </p>
                        </div>
                        <Badge variant="outline">{match.status}</Badge>
                      </div>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {result && cfg && (
          <Card>
            <CardContent className="py-6 space-y-4">
              <div className={`text-center p-4 md:p-6 rounded-lg ${cfg.bg}`}>
                <div className="flex justify-center mb-3">{cfg.icon}</div>
                <h3 className={`text-xl font-semibold ${cfg.color}`}>{cfg.title}</h3>

                {result.status === "Pending" && (
                  <p className="text-sm text-muted-foreground mt-2">
                    Your request <span className="font-mono font-bold">{result.token}</span> is being reviewed by our team.
                    We will contact you on <span className="font-medium">{result.mobile}</span> once approved.
                  </p>
                )}
                {result.status === "Approved" && (
                  <div className="text-sm text-muted-foreground mt-2 space-y-1">
                    <p>{result.fulfillmentMessage ?? "Our team will guide you on the center or centers where each approved item can be collected."}</p>
                    {result.fulfillmentCenters.length > 0 && (
                      <div className="pt-2 flex flex-wrap justify-center gap-2">
                        {result.fulfillmentCenters.map((center) => (
                          <Badge key={center.centerId} variant="outline" className="bg-card">
                            {center.centerName}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {result.status === "Rejected" && result.rejectionReason && (
                  <div className="mt-3 bg-card p-3 rounded text-sm text-left text-destructive">{result.rejectionReason}</div>
                )}
                {result.status === "Rejected" && (
                  <p className="text-sm text-muted-foreground mt-2">
                    In emergency, contact: <span className="font-medium text-foreground">{emergencyContactText()}</span>
                  </p>
                )}
                {result.status === "Active" && <p className="text-sm text-muted-foreground mt-2">Your request is currently active and devices are issued.</p>}
                {result.status === "Closed" && <p className="text-sm text-muted-foreground mt-2">Your loan cycle has been completed successfully.</p>}
                {result.dueDate && (
                  <div className="mt-3 inline-flex max-w-full items-center gap-2 rounded-full border border-border/70 bg-card px-3 py-1.5 text-xs text-foreground">
                    <CalendarClock className="h-3.5 w-3.5 text-primary" />
                    Due on {format(parseISO(result.dueDate), "dd MMM yyyy")}
                  </div>
                )}
              </div>

              {result.status === "Active" && (
                <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
                  {extensionMeta && (
                    <div className="rounded-md border bg-background p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <p className="text-sm font-medium text-foreground">{extensionMeta.title}</p>
                        <Badge variant="outline" className={extensionMeta.badgeClass}>
                          {extensionMeta.badge}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">{extensionMeta.body}</p>
                    </div>
                  )}

                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">Lease extension</p>
                      <p className="text-sm text-muted-foreground">
                        {result.extensionEligibilityReason ?? "Eligibility is based on your current due date and active items."}
                      </p>
                    </div>
                    {canRequestExtension && (
                      <Button onClick={() => navigate(`/extend?token=${encodeURIComponent(result.token)}`)} className="w-full sm:w-auto min-h-12">
                        Request extension
                      </Button>
                    )}
                  </div>

                  {!canRequestExtension && (
                    <p className="text-xs text-muted-foreground">
                      {result.pendingExtensionRequest
                        ? "A request is already pending for approver review."
                        : result.extensionEligibilityReason ?? "An extension request is not available yet for this token."}
                    </p>
                  )}
                </div>
              )}

              {latestHistory.length > 0 && (
                <div className="space-y-3">
                  <p className="text-base font-medium text-foreground">Extension history</p>
                  <div className="space-y-3">
                    {latestHistory.map((entry) => (
                      <div key={entry.id} className="rounded-lg border bg-muted/20 p-4 space-y-2">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <Badge variant="outline" className="capitalize">{entry.status}</Badge>
                          <span className="text-xs text-muted-foreground">
                            Requested {formatDistanceToNow(parseISO(entry.requestedAt), { addSuffix: true })}
                          </span>
                        </div>
                        <p className="text-sm text-foreground">
                          Requested date:{" "}
                          <span className="font-medium">
                            {entry.requestedDueDate ? format(parseISO(entry.requestedDueDate), "dd MMM yyyy") : entry.requestedDuration}
                          </span>
                        </p>
                        {entry.approvedDueDate && (
                          <p className="text-sm text-muted-foreground">
                            Approved due date: {format(parseISO(entry.approvedDueDate), "dd MMM yyyy")}
                          </p>
                        )}
                        {entry.reason && <p className="text-sm text-muted-foreground">Reason: {entry.reason}</p>}
                        {entry.rejectionReason && <p className="text-sm text-destructive">Rejection reason: {entry.rejectionReason}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <p className="text-sm font-medium text-foreground mb-2">Items {result.status === "Active" ? "Issued" : "Requested"}:</p>
                <div className="space-y-1.5">
                  {result.items.map((item) => (
                    <div key={`${item.sku}-${item.qty}`} className="flex items-center justify-between gap-3 text-sm border rounded-md px-3 py-2">
                      <div>
                        <span>{item.qty}x {item.sku}</span>
                        {item.dueDate && (
                          <p className="text-xs text-muted-foreground mt-1">Due: {format(parseISO(item.dueDate), "dd MMM yyyy")}</p>
                        )}
                      </div>
                      {item.serial && <Badge variant="secondary" className="font-mono text-xs">{item.serial}</Badge>}
                    </div>
                  ))}
                </div>
              </div>

              {result.notes && (
                <div>
                  <p className="text-sm font-medium text-foreground mb-2">Pickup / Fulfillment Notes:</p>
                  <div className="text-sm border rounded-md px-3 py-2 whitespace-pre-line">{result.notes}</div>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </main>
      <PublicFooter />
    </div>
  );
}
