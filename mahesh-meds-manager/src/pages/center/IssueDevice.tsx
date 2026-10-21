import { useEffect, useState } from "react";
import { Search, CheckCircle, AlertTriangle, Printer, ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCenterScope } from "@/hooks/useCenterScope";
import { apiFetch, needsHandoverOtp, sendHandoverOtp, verifyHandoverOtp } from "@/lib/api";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SerialNumberInput } from "@/components/SerialNumberInput";
import { OtpVerifyCard } from "@/components/OtpVerifyCard";
import { mobileFromSearch } from "@/lib/mobileSearch";

const steps = ["Find Request", "Verify Recipient", "Assign Assets", "Confirm & Issue"];

type SkuRow = { id: string; name: string };
type AssetRow = {
  id: string;
  serial_number: string;
  sku_id: string;
  center_id: string | null;
  status: string;
};

type LeaseLookup = {
  id: string;
  token_number: string;
  requestor_name: string;
  mobile: string;
  aadhar_number: string;
  preferred_center_id: string | null;
  status: string;
  skus: string[];
  notes?: string | null;
  items?: Array<{
    sku_id: string;
    sku_name: string;
    quantity_requested: number;
    asset_id?: string | null;
    pickup_center_name?: string | null;
  }>;
};
type LeaseIssueContext = LeaseLookup & {
  issue_items?: Array<{
    sku_id: string;
    sku_name: string;
    quantity_requested: number;
    asset_id?: string | null;
    local_available_count: number;
    source_centers: Array<{ center_id: string; center_name: string; available_count: number }>;
  }>;
};

function hasPendingLeaseLines(lease: LeaseLookup): boolean {
  if ((lease.items ?? []).length > 0) return (lease.items ?? []).some((item) => !item.asset_id);
  return lease.skus.length > 0;
}

function isReadyToIssue(lease: LeaseLookup): boolean {
  return lease.status === "approved" || (lease.status === "active" && hasPendingLeaseLines(lease));
}

export default function IssueDevice() {
  const { centerId, centerName } = useCenterScope();
  const [step, setStep] = useState(0);
  const [token, setToken] = useState("");
  const [lease, setLease] = useState<LeaseLookup | null>(null);
  const [tokenError, setTokenError] = useState("");
  const [skus, setSkus] = useState<SkuRow[]>([]);
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [serials, setSerials] = useState<Record<string, string>>({});
  const [serialStatus, setSerialStatus] = useState<Record<string, "valid" | "invalid" | "">>({});
  const [assetIds, setAssetIds] = useState<Record<string, string>>({});
  const [issued, setIssued] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [itemUnavailable, setItemUnavailable] = useState<Record<string, boolean>>({});
  /** False when every pending line belongs to some other center. */
  const [canIssueLocally, setCanIssueLocally] = useState(true);
  /** A mobile number's requests that are ready to issue, when there is more than one to choose from. */
  const [choices, setChoices] = useState<LeaseLookup[]>([]);
  /** The request whose OTP this user entered; the server lets them issue against it once, within 30 minutes. */
  const [verifiedLeaseId, setVerifiedLeaseId] = useState<string | null>(null);

  useEffect(() => {
    if (!centerId) return;
    let cancelled = false;
    async function load() {
      try {
        const [skuList, assetList] = await Promise.all([
          apiFetch<SkuRow[]>("/api/v1/skus"),
          apiFetch<AssetRow[]>("/api/v1/assets"),
        ]);
        if (cancelled) return;
        setSkus(skuList);
        setAssets(assetList.filter((a) => a.center_id === centerId));
      } catch {
        toast.error("Could not load SKUs or assets");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [centerId]);

  const skuNameToId = Object.fromEntries(skus.map((s) => [s.name, s.id]));

  const requestedItems = lease
    ? ((lease.items ?? []).length > 0
        ? (lease.items ?? [])
            .filter((item) => !item.asset_id)
            .map((item, idx) => ({ key: `${item.sku_name}-${idx}`, sku: item.sku_name, pickupCenter: item.pickup_center_name }))
        : lease.skus.map((name, idx) => ({ key: `${name}-${idx}`, sku: name, pickupCenter: null as string | null | undefined }))
      )
    : [];

  const handleFindRequest = async () => {
    const query = token.trim();
    setChoices([]);
    if (!query) {
      setTokenError("Enter a token or the requester's mobile number");
      setLease(null);
      return;
    }
    const mobile = mobileFromSearch(query);
    if (mobile === null) {
      await loadLease(query);
      return;
    }
    setLease(null);
    if (!mobile) {
      setTokenError("Enter a valid 10-digit mobile number or a token");
      return;
    }
    try {
      const found = await apiFetch<LeaseLookup[]>(`/api/v1/lease-requests/by-mobile/${mobile}`);
      const ready = found.filter(isReadyToIssue);
      if (ready.length === 1) {
        await loadLease(ready[0]!.token_number);
      } else if (ready.length > 1) {
        setTokenError("");
        setChoices(ready);
      } else if (found.length > 0) {
        const summary = found.map((r) => `${r.token_number} (${r.status})`).join(", ");
        setTokenError(`No request for this number is ready to issue: ${summary}.`);
      } else {
        setTokenError("No lease request found for this mobile number.");
      }
    } catch {
      setTokenError("Could not look up this mobile number. Please try again.");
    }
  };

  const loadLease = async (t: string) => {
    setChoices([]);
    try {
      const found = await apiFetch<LeaseLookup>(`/api/v1/lease-requests/by-token/${encodeURIComponent(t)}`);
      let issueContext: LeaseIssueContext | null = null;
      if (centerId) {
        try {
          issueContext = await apiFetch<LeaseIssueContext>(
            `/api/v1/lease-requests/by-token/${encodeURIComponent(t)}/issue-context/${encodeURIComponent(centerId)}`,
          );
        } catch {
          issueContext = null;
        }
      }
      if (!found.skus.length) {
        setTokenError("This request has no line items yet.");
        setLease(null);
        setCanIssueLocally(true);
        return;
      }
      setLease(found);
      setTokenError("");
      if (found.id !== verifiedLeaseId) setVerifiedLeaseId(null);
      const nextSerials: Record<string, string> = {};
      const nextStatus: Record<string, "valid" | "invalid" | ""> = {};
      const nextIds: Record<string, string> = {};
      const pendingSkuNames =
        (found.items ?? []).length > 0
          ? (found.items ?? []).filter((item) => !item.asset_id).map((item) => item.sku_name)
          : found.skus;
      pendingSkuNames.forEach((name, idx) => {
        const key = `${name}-${idx}`;
        nextSerials[key] = "";
        nextStatus[key] = "";
        nextIds[key] = "";
      });
      setSerials(nextSerials);
      setSerialStatus(nextStatus);
      setAssetIds(nextIds);
      const unavailableMap: Record<string, boolean> = {};
      const issueItems = issueContext?.issue_items ?? [];
      const issueQueueBySku: Record<string, LeaseIssueContext["issue_items"]> = {};
      for (const row of issueItems) {
        if (!issueQueueBySku[row.sku_name]) issueQueueBySku[row.sku_name] = [];
        issueQueueBySku[row.sku_name]!.push(row);
      }
      pendingSkuNames.forEach((name, idx) => {
        const key = `${name}-${idx}`;
        const queue = issueQueueBySku[name] ?? [];
        const row = queue.shift();
        unavailableMap[key] = (row?.local_available_count ?? 0) <= 0;
      });
      setItemUnavailable(unavailableMap);
      const hasPending = pendingSkuNames.length > 0;
      const allOffCenterOnly =
        hasPending && pendingSkuNames.every((name, idx) => unavailableMap[`${name}-${idx}`]);
      setCanIssueLocally(hasPending && !allOffCenterOnly);
    } catch {
      setTokenError("No lease request found with this token.");
      setLease(null);
      setCanIssueLocally(true);
    }
  };

  const handleSerialChange = (key: string, skuName: string, value: string) => {
    setSerials((p) => ({ ...p, [key]: value }));
    const skuId = skuNameToId[skuName];
    const takenElsewhere = new Set(
      requestedItems.filter((ri) => ri.key !== key).map((ri) => assetIds[ri.key]).filter(Boolean) as string[],
    );
    const asset = assets.find(
      (a) =>
        a.serial_number.toUpperCase() === value.trim().toUpperCase() &&
        a.sku_id === skuId &&
        a.status === "available" &&
        !takenElsewhere.has(a.id),
    );
    setSerialStatus((p) => ({ ...p, [key]: value.length > 0 ? (asset ? "valid" : "invalid") : "" }));
    setAssetIds((p) => ({ ...p, [key]: asset?.id ?? "" }));
  };

  const takenAssetIdsExcept = (exceptKey: string) =>
    new Set(
      requestedItems.filter((ri) => ri.key !== exceptKey).map((ri) => assetIds[ri.key]).filter(Boolean) as string[],
    );

  const availableAssetsForLine = (skuName: string, lineKey: string) => {
    const skuId = skuNameToId[skuName];
    if (!skuId) return [];
    const taken = takenAssetIdsExcept(lineKey);
    return assets.filter((a) => a.sku_id === skuId && a.status === "available" && !taken.has(a.id));
  };

  const handlePickFromList = (key: string, skuName: string, assetId: string) => {
    if (assetId === "__manual__") {
      setSerials((p) => ({ ...p, [key]: "" }));
      setSerialStatus((p) => ({ ...p, [key]: "" }));
      setAssetIds((p) => ({ ...p, [key]: "" }));
      return;
    }
    const list = availableAssetsForLine(skuName, key);
    const asset = list.find((a) => a.id === assetId);
    if (!asset) return;
    setSerials((p) => ({ ...p, [key]: asset.serial_number }));
    setSerialStatus((p) => ({ ...p, [key]: "valid" }));
    setAssetIds((p) => ({ ...p, [key]: asset.id }));
  };

  const pickListValueForLine = (key: string, skuName: string) => {
    const id = assetIds[key];
    if (!id) return "__manual__";
    const list = availableAssetsForLine(skuName, key);
    const inList = list.some((a) => a.id === id);
    const serial = (serials[key] ?? "").trim();
    const asset = assets.find((a) => a.id === id);
    const serialMatches = asset && asset.serial_number.trim().toUpperCase() === serial.toUpperCase();
    return inList && serialMatches ? id : "__manual__";
  };

  const localPendingItems = lease ? requestedItems.filter((item) => !itemUnavailable[item.key]) : [];

  const allValid =
    lease && localPendingItems.length > 0
      ? localPendingItems.every((item) => serialStatus[item.key] === "valid")
      : false;

  const hasPendingLines = lease ? hasPendingLeaseLines(lease) : false;
  const canEnterIssueFlow = lease?.status === "approved" || (lease?.status === "active" && hasPendingLines);
  const isAlreadyFullyIssued = lease?.status === "active" && !hasPendingLines;

  const handleConfirmIssue = async () => {
    if (!lease || !centerId) return;
    setSubmitting(true);
    try {
      // The server marks the assigned devices as leased in the same update as the request.
      const existingItems = (lease.items ?? []).length
        ? (lease.items ?? []).map((item) => ({
            sku_id: item.sku_id,
            quantity_requested: item.quantity_requested,
            asset_id: item.asset_id ?? null,
          }))
        : lease.skus.map((name) => ({
            sku_id: skuNameToId[name],
            quantity_requested: 1,
            asset_id: null,
          }));

      const pendingKeysBySku: Record<string, string[]> = {};
      for (const item of localPendingItems) {
        if (!pendingKeysBySku[item.sku]) pendingKeysBySku[item.sku] = [];
        pendingKeysBySku[item.sku]!.push(item.key);
      }

      const updatedItems = existingItems.map((existing) => {
        if (existing.asset_id) return existing;
        const skuName = skus.find((s) => s.id === existing.sku_id)?.name;
        if (!skuName) return existing;
        const pendingKey = (pendingKeysBySku[skuName] ?? []).shift();
        if (!pendingKey) return existing;
        return {
          ...existing,
          asset_id: assetIds[pendingKey] || null,
        };
      });
      const allIssued = updatedItems.every((item) => !!item.asset_id);

      await apiFetch(`/api/v1/lease-requests/${lease.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: allIssued ? "active" : "approved",
          items: updatedItems,
        }),
      });
      setAssets((prev) =>
        prev.map((a) => {
          const issuedId = Object.values(assetIds).find((v) => v === a.id);
          return issuedId ? { ...a, status: "leased" } : a;
        }),
      );
      setIssued(true);
      setVerifiedLeaseId(null);
      toast.success("Issue recorded");
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : "Failed to complete issue");
      if (needsHandoverOtp(error)) {
        setVerifiedLeaseId(null);
        setStep(1);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2 justify-between text-sm">
          {steps.map((s, i) => (
            <span key={s} className={i <= step ? "text-primary font-medium" : "text-muted-foreground"}>
              {s}
            </span>
          ))}
        </div>
        <Progress value={((step + 1) / steps.length) * 100} className="h-2" />
      </div>

      {!issued && step === 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step 1: Find Lease Request</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                placeholder="Token or requester's mobile number"
                aria-label="Token or requester's mobile number"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleFindRequest();
                }}
              />
              <Button onClick={() => void handleFindRequest()}>
                <Search className="h-4 w-4 mr-1" /> Find
              </Button>
            </div>
            {tokenError && <p className="text-sm text-destructive">{tokenError}</p>}
            {choices.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  This number has {choices.length} requests ready to issue. Choose one:
                </p>
                {choices.map((choice) => (
                  <button
                    key={choice.id}
                    type="button"
                    className="w-full text-left border rounded-lg p-3 hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      setToken(choice.token_number);
                      void loadLease(choice.token_number);
                    }}
                  >
                    <span className="font-mono font-medium">{choice.token_number}</span>
                    <span className="text-sm text-muted-foreground"> · {choice.requestor_name} · {choice.skus.join(", ")}</span>
                  </button>
                ))}
              </div>
            )}
            {lease && (
              <div className="border rounded-lg p-4 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Name:</span> {lease.requestor_name}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Mobile:</span> {lease.mobile}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Aadhar:</span> {lease.aadhar_number}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Center:</span> {centerName}
                  </div>
                </div>
                <div className="text-sm">
                  <span className="text-muted-foreground">Requested:</span> {lease.skus.join(", ")}
                </div>
                <Badge
                  className={
                    lease.status === "expired"
                      ? "bg-warning/15 text-warning border-warning/30"
                      : "bg-success/15 text-success border-success/30"
                  }
                  variant="outline"
                >
                  {lease.status}
                </Badge>
                {lease.status === "expired" && (
                  <div className="flex items-center gap-2 text-warning text-sm">
                    <AlertTriangle className="h-4 w-4" /> Pickup window expired. Ask an approver to re-approve this request before issuing.
                  </div>
                )}
                {!canEnterIssueFlow && !isAlreadyFullyIssued && lease.status !== "expired" && (
                  <div className="flex items-center gap-2 text-warning text-sm">
                    <AlertTriangle className="h-4 w-4" /> Request is not approved yet
                  </div>
                )}
                {isAlreadyFullyIssued && (
                  <div className="flex items-center gap-2 text-info text-sm">
                    <AlertTriangle className="h-4 w-4" /> Devices have already been issued for this token
                  </div>
                )}
                {!canIssueLocally && hasPendingLeaseLines(lease) && (
                  <p className="text-sm text-warning flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                    No pending line item for this token is issuable from {centerName} right now. Each asset must be
                    issued from the center where it is already available.
                  </p>
                )}
                <Button
                  onClick={() => setStep(verifiedLeaseId === lease.id ? 2 : 1)}
                  disabled={!canEnterIssueFlow || !canIssueLocally}
                >
                  {verifiedLeaseId === lease.id ? "Proceed to Asset Scan" : "Continue to OTP check"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!issued && step === 1 && lease && centerId && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Step 2: Verify Recipient</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <p>
                <span className="text-muted-foreground">Token:</span> <span className="font-mono">{lease.token_number}</span>
              </p>
              <p>
                <span className="text-muted-foreground">Requester:</span> {lease.requestor_name}
              </p>
              <p className="text-muted-foreground pt-2">
                Devices are handed over only to the person approved to receive them. One OTP covers this handover for
                30 minutes.
              </p>
            </CardContent>
          </Card>
          <OtpVerifyCard
            title="OTP to the requester's mobile"
            intro={`We'll text a one-time password (OTP) to the requester's mobile ending ${lease.mobile.slice(-2)}. Ask the person collecting the devices to read it out.`}
            sentText={(sentTo) =>
              `Enter the 6-digit OTP sent to the mobile ${sentTo}, as read out by the person collecting the devices.`
            }
            onSend={() => sendHandoverOtp(lease.id, centerId)}
            onVerify={(otp) => verifyHandoverOtp(lease.id, centerId, otp)}
            onVerified={() => {
              setVerifiedLeaseId(lease.id);
              toast.success("Recipient verified");
              setStep(2);
            }}
            resetKey={lease.id}
          />
          <Button variant="outline" onClick={() => setStep(0)}>
            Back
          </Button>
        </div>
      )}

      {!issued && step === 2 && lease && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step 3: Assign Assets</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {requestedItems.map((item) => {
              const pickPool = availableAssetsForLine(item.sku, item.key);
              return (
              <div key={item.key} className="border rounded-lg p-4 space-y-2">
                <p className="font-medium text-sm">{item.sku}</p>
                {item.pickupCenter && (
                  <p className="text-xs text-muted-foreground">Requested pickup: {item.pickupCenter}</p>
                )}
                {itemUnavailable[item.key] ? (
                  <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs space-y-2">
                    <div className="flex items-center gap-2 text-warning font-medium">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      Not available at this center
                    </div>
                    <p className="text-muted-foreground">This line item must be collected from whichever center already has the asset.</p>
                  </div>
                ) : (
                  <div className="text-xs text-success">Available at this center. Scan and issue locally.</div>
                )}
                {!itemUnavailable[item.key] && pickPool.length > 0 && (
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Pick from available stock ({centerName})</Label>
                    <Select
                      value={pickListValueForLine(item.key, item.sku)}
                      onValueChange={(v) => handlePickFromList(item.key, item.sku, v)}
                    >
                      <SelectTrigger className="h-9 font-mono text-sm">
                        <SelectValue placeholder="Select serial or enter below…" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__manual__" className="text-muted-foreground">
                          Type or scan serial below…
                        </SelectItem>
                        {pickPool.map((a) => (
                          <SelectItem key={a.id} value={a.id} className="font-mono text-xs">
                            {a.serial_number}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {!itemUnavailable[item.key] && pickPool.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No units are currently listed as available for this SKU at this center.
                  </p>
                )}
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Serial number (scan or type)</Label>
                  <div className="flex gap-2 items-start">
                    <div className="flex-1">
                      <SerialNumberInput
                        value={serials[item.key] || ""}
                        onChange={(value) => handleSerialChange(item.key, item.sku, value)}
                        onScanned={(value) => handleSerialChange(item.key, item.sku, value)}
                        placeholder="Scan QR or enter serial..."
                        className="font-mono"
                      />
                    </div>
                    {serialStatus[item.key] === "valid" && <CheckCircle className="h-5 w-5 text-success shrink-0" />}
                    {serialStatus[item.key] === "invalid" && <span className="text-xs text-destructive shrink-0">Invalid</span>}
                  </div>
                </div>
              </div>
            );
            })}
            {localPendingItems.length === 0 && requestedItems.length > 0 && (
              <p className="text-sm text-muted-foreground border rounded-md p-3 bg-muted/30">
                All remaining lines belong to other centers. The requestor must collect those items from the centers where
                they are already available.
              </p>
            )}
            <div className="flex flex-col sm:flex-row gap-2">
              <Button variant="outline" onClick={() => setStep(0)}>
                Back
              </Button>
              <Button onClick={() => setStep(3)} disabled={!allValid || localPendingItems.length === 0}>
                Verify All Assets
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {!issued && step === 3 && lease && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step 4: Confirm & Issue</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto">
            <Table className="min-w-[420px]">
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Serial Number</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {localPendingItems.map((item) => (
                  <TableRow key={item.key}>
                    <TableCell>{item.sku}</TableCell>
                    <TableCell className="font-mono">{serials[item.key]}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
            <div className="text-sm space-y-1">
              <p>
                <span className="text-muted-foreground">Lessee:</span> {lease.requestor_name}
              </p>
              <p>
                <span className="text-muted-foreground">Issue Date:</span> {new Date().toLocaleDateString("en-IN")}
              </p>
              <p className="flex items-center gap-1 text-success">
                <ShieldCheck className="h-4 w-4" /> Recipient verified by OTP
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <Button variant="outline" onClick={() => setStep(2)}>
                Back
              </Button>
              <Button
                className="bg-success hover:bg-success/90 text-success-foreground"
                onClick={handleConfirmIssue}
                disabled={submitting || !allValid}
              >
                {submitting ? "Saving..." : "Confirm Issue"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {issued && lease && (
        <Card className="text-center">
          <CardContent className="py-10 space-y-4">
            <CheckCircle className="h-16 w-16 text-success mx-auto" />
            <h2 className="text-xl font-semibold text-foreground">Devices Issued Successfully!</h2>
            <div className="border rounded-lg p-4 text-sm text-left max-w-sm mx-auto space-y-1">
              <p>
                <span className="text-muted-foreground">Lessee:</span> {lease.requestor_name}
              </p>
              <p>
                <span className="text-muted-foreground">Token:</span> {lease.token_number}
              </p>
              {localPendingItems.map((item) => (
                <p key={item.key}>
                  <span className="text-muted-foreground">{item.sku}:</span> {serials[item.key]}
                </p>
              ))}
              <p>
                <span className="text-muted-foreground">Issued:</span> {new Date().toLocaleDateString("en-IN")}
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 justify-center">
              <Button variant="outline" className="gap-1">
                <Printer className="h-4 w-4" /> Print
              </Button>
              <Button
                onClick={() => {
                  setStep(0);
                  setToken("");
                  setLease(null);
                  setSerials({});
                  setSerialStatus({});
                  setAssetIds({});
                  setIssued(false);
                  setCanIssueLocally(true);
                  setChoices([]);
                  setVerifiedLeaseId(null);
                }}
              >
                Issue Another
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
