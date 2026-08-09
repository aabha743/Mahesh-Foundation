import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, CheckCircle, ArrowRight, AlertTriangle } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { useCenterScope } from "@/hooks/useCenterScope";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";
import { SerialNumberInput } from "@/components/SerialNumberInput";

const tokenSteps = ["Find lease", "Plan fulfillment", "Confirm"];

type AssetRow = {
  id: string;
  serial_number: string;
  sku_id: string;
  center_id: string | null;
  home_center_id: string | null;
  status: string;
};
type AssetTransferRow = {
  id: string;
  asset_id: string;
  from_center_id: string | null;
  to_center_id: string | null;
  status: string;
  transfer_reason?: string | null;
  notes?: string | null;
  reference_number?: string | null;
  created_at?: string;
};

type SkuRow = { id: string; name: string };

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
  items?: Array<{ sku_id: string; sku_name: string; quantity_requested: number; asset_id?: string | null }>;
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

export default function TransferAsset() {
  const { centerId, centerName } = useCenterScope();
  const [searchParams] = useSearchParams();
  const [centers, setCenters] = useState<Array<{ id: string; name: string }>>([]);
  const [skus, setSkus] = useState<SkuRow[]>([]);

  const [tokenStep, setTokenStep] = useState(0);
  const [token, setToken] = useState("");

  useEffect(() => {
    const t = searchParams.get("token")?.trim();
    if (t) setToken(t);
  }, [searchParams]);
  const [tokenError, setTokenError] = useState("");
  const [lease, setLease] = useState<LeaseLookup | null>(null);
  const [itemUnavailable, setItemUnavailable] = useState<Record<string, boolean>>({});
  const [itemSourceOptions, setItemSourceOptions] = useState<Record<string, Array<{ center_id: string; center_name: string }>>>({});
  const [missingAction, setMissingAction] = useState<Record<string, "transfer" | "collect">>({});
  const [sourceCenterByItem, setSourceCenterByItem] = useState<Record<string, string>>({});
  const [tokenSubmitting, setTokenSubmitting] = useState(false);
  const [tokenCompleted, setTokenCompleted] = useState(false);

  const [assetsById, setAssetsById] = useState<Record<string, AssetRow>>({});
  const [skuNameById, setSkuNameById] = useState<Record<string, string>>({});
  const [transferQueue, setTransferQueue] = useState<AssetTransferRow[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<Record<string, boolean>>({});
  const [dispatchSerialByTransfer, setDispatchSerialByTransfer] = useState<Record<string, string>>({});
  const [receiveSerialByTransfer, setReceiveSerialByTransfer] = useState<Record<string, string>>({});

  const skuNameToId = useMemo(() => Object.fromEntries(skus.map((s) => [s.name, s.id])), [skus]);

  const requestedItems = useMemo(() => {
    if (!lease) return [];
    if ((lease.items ?? []).length > 0) {
      return (lease.items ?? [])
        .filter((item) => !item.asset_id)
        .map((item, idx) => ({ key: `${item.sku_name}-${idx}`, sku: item.sku_name }));
    }
    return lease.skus.map((name, idx) => ({ key: `${name}-${idx}`, sku: name }));
  }, [lease]);

  const externalItems = useMemo(
    () => requestedItems.filter((item) => itemUnavailable[item.key]),
    [requestedItems, itemUnavailable],
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [centerList, skuList] = await Promise.all([
          apiFetch<Array<{ id: string; name: string }>>("/api/v1/centers"),
          apiFetch<SkuRow[]>("/api/v1/skus"),
        ]);
        if (cancelled) return;
        setCenters(centerList);
        setSkus(skuList);
      } catch {
        toast.error("Could not load centers or SKUs");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadQueue = useCallback(async () => {
    if (!centerId) return;
    setQueueLoading(true);
    setQueueError(null);
    try {
      const [transferList, assetList, skuList] = await Promise.all([
        apiFetch<AssetTransferRow[]>("/api/v1/asset-transfers"),
        apiFetch<AssetRow[]>("/api/v1/assets"),
        apiFetch<Array<{ id: string; name: string }>>("/api/v1/skus"),
      ]);
      setTransferQueue(
        transferList.filter((t) => t.from_center_id === centerId || t.to_center_id === centerId),
      );
      setAssetsById(Object.fromEntries(assetList.map((a) => [a.id, a])));
      setSkuNameById(Object.fromEntries(skuList.map((s) => [s.id, s.name])));
    } catch (error) {
      console.error("Failed to load transfer queue:", error);
      setQueueError("Failed to load transfer queue");
      toast.error("Could not load transfer queue");
      // Set empty state to prevent crashes
      setTransferQueue([]);
      setAssetsById({});
      setSkuNameById({});
    } finally {
      setQueueLoading(false);
    }
  }, [centerId]);

  useEffect(() => {
    if (!centerId) return;
    // Only load queue after auth is complete and centerId is available
    const timer = setTimeout(() => {
      void loadQueue();
    }, 100); // Small delay to ensure auth is complete
    return () => clearTimeout(timer);
  }, [centerId, loadQueue]);

  const handleFindLease = async (tokenOverride?: string) => {
    const t = (tokenOverride ?? token).trim();
    if (!t) {
      setTokenError("Enter a token");
      setLease(null);
      return;
    }
    if (!centerId || !centerName) return;
    setTokenError("");
    try {
      const found = await apiFetch<LeaseLookup>(`/api/v1/lease-requests/by-token/${encodeURIComponent(t)}`);
      let issueContext: LeaseIssueContext | null = null;
      try {
        issueContext = await apiFetch<LeaseIssueContext>(
          `/api/v1/lease-requests/by-token/${encodeURIComponent(t)}/issue-context/${encodeURIComponent(centerId)}`,
        );
      } catch {
        issueContext = null;
      }
      const pickupAllowedHere =
        (found.notes ?? "").toLowerCase().includes("[pickup plan]") &&
        (found.notes ?? "").toLowerCase().includes(centerName.toLowerCase());
      if (centerId && found.preferred_center_id && found.preferred_center_id !== centerId && !pickupAllowedHere) {
        setTokenError("This request is assigned to a different center.");
        setLease(null);
        return;
      }
      if (!found.skus.length) {
        setTokenError("This request has no line items yet.");
        setLease(null);
        return;
      }

      const pendingSkuNames =
        (found.items ?? []).length > 0
          ? (found.items ?? []).filter((item) => !item.asset_id).map((item) => item.sku_name)
          : found.skus;

      const unavailableMap: Record<string, boolean> = {};
      const sourceOptionsMap: Record<string, Array<{ center_id: string; center_name: string }>> = {};
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
        sourceOptionsMap[key] = (row?.source_centers ?? []).map((s) => ({
          center_id: s.center_id,
          center_name: s.center_name,
        }));
      });

      setLease(found);
      setItemUnavailable(unavailableMap);
      setItemSourceOptions(sourceOptionsMap);
      setMissingAction({});
      setSourceCenterByItem({});
      setTokenStep(0);
      setTokenCompleted(false);

      const ext = pendingSkuNames.map((name, idx) => unavailableMap[`${name}-${idx}`]).filter(Boolean);
      if (ext.length === 0) {
        toast.info("All pending lines have stock at this center. Use Issue device to assign serials.");
      }
    } catch {
      setTokenError("No lease request found with this token.");
      setLease(null);
    }
  };

  const externalAllValid =
    externalItems.length > 0 &&
    externalItems.every((item) => {
      const action = missingAction[item.key];
      const src = sourceCenterByItem[item.key];
      return !!action && !!src;
    });

  const handleConfirmTokenPlans = async () => {
    if (!lease || !centerId) return;
    setTokenSubmitting(true);
    try {
      const planNotes: string[] = [];
      for (const item of externalItems) {
        const action = missingAction[item.key];
        const sourceCenterId = sourceCenterByItem[item.key];
        const sourceCenterName = centers.find((c) => c.id === sourceCenterId)?.name ?? "Other center";
        if (!action || !sourceCenterId) continue;
        if (action === "transfer") {
          const assetList = await apiFetch<AssetRow[]>("/api/v1/assets");
          const sourceAsset = assetList.find(
            (a) =>
              a.center_id === sourceCenterId &&
              a.status === "available" &&
              a.sku_id === skuNameToId[item.sku],
          );
          if (sourceAsset) {
            await apiFetch("/api/v1/asset-transfers", {
              method: "POST",
              body: JSON.stringify({
                asset_id: sourceAsset.id,
                from_center_id: sourceCenterId,
                to_center_id: centerId,
                transfer_reason: "fulfillment_transfer",
                status: "initiated",
                notes: `Temporary fulfillment transfer for token ${lease.token_number} (${item.sku})`,
              }),
            });
            planNotes.push(
              `[Transfer Initiated] ${item.sku} from ${sourceCenterName} to ${centerName} (ownership remains with ${sourceCenterName})`,
            );
          } else {
            toast.error(`No available asset found at ${sourceCenterName} for ${item.sku}`);
            return;
          }
        } else {
          planNotes.push(`[Pickup Plan] ${item.sku} to be collected from ${sourceCenterName}`);
        }
      }

      const mergedNotes =
        planNotes.length > 0
          ? `${lease.notes ? `${lease.notes}\n` : ""}${lease.token_number} fulfillment:\n${planNotes.join("\n")}`
          : undefined;

      if (mergedNotes) {
        await apiFetch(`/api/v1/lease-requests/${lease.id}`, {
          method: "PATCH",
          body: JSON.stringify({ notes: mergedNotes }),
        });
      }

      await loadQueue();
      setTokenCompleted(true);
      toast.success("Fulfillment plans saved");
    } catch {
      toast.error("Failed to save plans");
    } finally {
      setTokenSubmitting(false);
    }
  };

  const updateTransferStatus = async (transferId: string, status: string) => {
    try {
      await apiFetch(`/api/v1/asset-transfers/${transferId}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      return true;
    } catch {
      return false;
    }
  };

  const handleDispatch = async (transfer: AssetTransferRow) => {
    const asset = assetsById[transfer.asset_id];
    if (!asset) return;
    
    // Check for duplicate active transfers
    const activeTransfer = transferQueue.find(
      (t) => t.asset_id === transfer.asset_id && 
      t.status !== "completed" && 
      t.status !== "cancelled" &&
      t.id !== transfer.id
    );
    if (activeTransfer) {
      toast.error(`This asset already has an active transfer (${activeTransfer.id}). Please complete or cancel it first.`);
      return;
    }
    
    const scanned = (dispatchSerialByTransfer[transfer.id] ?? "").trim().toUpperCase();
    if (!scanned || scanned !== asset.serial_number.toUpperCase()) {
      toast.error("Scan or enter correct serial before dispatch");
      return;
    }
    
    setIsSubmitting((prev) => ({ ...prev, [transfer.id]: true }));
    try {
      await apiFetch(`/api/v1/assets/${asset.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "in_transit" }),
      });
      const statusPatched = await updateTransferStatus(transfer.id, "in_transit");
      await loadQueue();
      toast.success(statusPatched ? "Transfer dispatched" : "Asset marked in transit");
      // Clear the serial input after successful dispatch
      setDispatchSerialByTransfer((prev) => ({ ...prev, [transfer.id]: "" }));
    } catch {
      toast.error("Failed to dispatch transfer");
    } finally {
      setIsSubmitting((prev) => ({ ...prev, [transfer.id]: false }));
    }
  };

  const handleReceive = async (transfer: AssetTransferRow) => {
    const asset = assetsById[transfer.asset_id];
    if (!asset || !centerId) return;
    
    // Check for duplicate active transfers
    const activeTransfer = transferQueue.find(
      (t) => t.asset_id === transfer.asset_id && 
      t.status !== "completed" && 
      t.status !== "cancelled" &&
      t.id !== transfer.id
    );
    if (activeTransfer) {
      toast.error(`This asset already has an active transfer (${activeTransfer.id}). Please complete or cancel it first.`);
      return;
    }
    
    const scanned = (receiveSerialByTransfer[transfer.id] ?? "").trim().toUpperCase();
    if (!scanned || scanned !== asset.serial_number.toUpperCase()) {
      toast.error("Scan or enter correct serial before receive");
      return;
    }
    
    setIsSubmitting((prev) => ({ ...prev, [transfer.id]: true }));
    try {
      await apiFetch(`/api/v1/assets/${asset.id}`, {
        method: "PATCH",
        body: JSON.stringify({ center_id: centerId, status: "available" }),
      });
      const statusPatched = await updateTransferStatus(transfer.id, "completed");
      await loadQueue();
      toast.success(statusPatched ? "Transfer received and completed" : "Asset received");
      // Clear the serial input after successful receive
      setReceiveSerialByTransfer((prev) => ({ ...prev, [transfer.id]: "" }));
    } catch {
      toast.error("Failed to receive transfer");
    } finally {
      setIsSubmitting((prev) => ({ ...prev, [transfer.id]: false }));
    }
  };

  const outgoingQueue = transferQueue.filter((t) => t.from_center_id === centerId && t.status === "initiated");
  const incomingQueue = transferQueue.filter(
    (t) => t.to_center_id === centerId && (t.status === "initiated" || t.status === "in_transit"),
  );

  const resetTokenWizard = () => {
    setToken("");
    setLease(null);
    setTokenStep(0);
    setTokenError("");
    setItemUnavailable({});
    setItemSourceOptions({});
    setMissingAction({});
    setSourceCenterByItem({});
    setTokenCompleted(false);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lease token — transfer or pickup plan</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
             When stock is here, use{" "}
            <Link to="/center/issue" className="underline font-medium text-foreground">
              Issue device
            </Link>{" "}
            to issue serials.
          </p>
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2 justify-between text-sm">
              {tokenSteps.map((s, i) => (
                <span key={s} className={i <= tokenStep ? "text-primary font-medium" : "text-muted-foreground"}>
                  {s}
                </span>
              ))}
            </div>
            <Progress value={((tokenStep + 1) / tokenSteps.length) * 100} className="h-2" />
          </div>

          {!tokenCompleted && tokenStep === 0 && (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row gap-2">
                <Input placeholder="Enter lease token" value={token} onChange={(e) => setToken(e.target.value)} />
                <Button onClick={() => void handleFindLease()}>
                  <Search className="h-4 w-4 mr-1" /> Find
                </Button>
              </div>
              {tokenError && <p className="text-sm text-destructive">{tokenError}</p>}
              {lease && (
                <div className="border rounded-lg p-4 space-y-2 text-sm">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <span className="text-muted-foreground">Token:</span>{" "}
                      <span className="font-mono font-medium">{lease.token_number}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Requestor:</span> {lease.requestor_name}
                    </div>
                  </div>
                  <Badge variant="outline">{lease.status}</Badge>
                  {externalItems.length === 0 && requestedItems.length > 0 && (
                    <p className="text-xs text-muted-foreground flex items-center gap-2">
                      <CheckCircle className="h-4 w-4 text-success shrink-0" />
                      Pending lines appear to have stock at this center. Use Issue device to complete issuance.
                    </p>
                  )}
                  {requestedItems.length === 0 && (
                    <p className="text-xs text-muted-foreground">No pending lines on this lease.</p>
                  )}
                  {externalItems.length > 0 && (
                    <Button onClick={() => setTokenStep(1)}>Plan fulfillment for off-center lines</Button>
                  )}
                </div>
              )}
            </div>
          )}

          {!tokenCompleted && tokenStep === 1 && lease && (
            <div className="space-y-4">
              <p className="text-sm font-medium">Off-center lines ({externalItems.length})</p>
              {externalItems.map((item) => (
                <div key={item.key} className="border rounded-lg p-4 space-y-2">
                  <p className="font-medium text-sm">{item.sku}</p>
                  <div className="flex items-center gap-2 text-warning text-xs">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    Not available at {centerName}. Choose how to fulfill.
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <Select
                      value={missingAction[item.key] ?? ""}
                      onValueChange={(value: "transfer" | "collect") =>
                        setMissingAction((prev) => ({ ...prev, [item.key]: value }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Action" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="transfer">Request transfer to this center</SelectItem>
                        <SelectItem value="collect">Requestor collects at source center</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select
                      value={sourceCenterByItem[item.key] ?? ""}
                      onValueChange={(value) => setSourceCenterByItem((prev) => ({ ...prev, [item.key]: value }))}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Source center" />
                      </SelectTrigger>
                      <SelectContent>
                        {(itemSourceOptions[item.key] ?? []).length > 0 ? (
                          (itemSourceOptions[item.key] ?? []).map((c) => (
                            <SelectItem key={c.center_id} value={c.center_id}>
                              {c.center_name}
                            </SelectItem>
                          ))
                        ) : (
                          centers
                            .filter((c) => c.id !== centerId)
                            .map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.name}
                              </SelectItem>
                            ))
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ))}
              <div className="flex flex-col sm:flex-row gap-2">
                <Button variant="outline" onClick={() => setTokenStep(0)}>
                  Back
                </Button>
                <Button onClick={() => setTokenStep(2)} disabled={!externalAllValid}>
                  Review & confirm
                </Button>
              </div>
            </div>
          )}

          {!tokenCompleted && tokenStep === 2 && lease && (
            <div className="space-y-4">
              <div className="flex items-center justify-center gap-4 py-2 text-sm">
                <div className="text-center">
                  <p className="text-muted-foreground">Token</p>
                  <p className="font-mono font-semibold">{lease.token_number}</p>
                </div>
                <ArrowRight className="h-5 w-5 text-primary shrink-0" />
                <div className="text-center">
                  <p className="text-muted-foreground">Center</p>
                  <p className="font-semibold">{centerName}</p>
                </div>
              </div>
              <ul className="border rounded-lg divide-y text-sm">
                {externalItems.map((item) => (
                  <li key={item.key} className="p-3 flex flex-col sm:flex-row sm:justify-between gap-2">
                    <span className="font-medium">{item.sku}</span>
                    <span className="text-muted-foreground text-right">
                      {missingAction[item.key] === "transfer" ? "Transfer in" : "Pickup at source"} ·{" "}
                      {centers.find((c) => c.id === sourceCenterByItem[item.key])?.name ?? "—"}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex flex-col sm:flex-row gap-2">
                <Button variant="outline" onClick={() => setTokenStep(1)}>
                  Back
                </Button>
                <Button onClick={() => void handleConfirmTokenPlans()} disabled={tokenSubmitting || !externalAllValid}>
                  {tokenSubmitting ? "Saving…" : "Confirm plans"}
                </Button>
              </div>
            </div>
          )}

          {tokenCompleted && lease && (
            <div className="rounded-lg border border-success/30 bg-success/5 p-4 text-center space-y-3">
              <CheckCircle className="h-10 w-10 text-success mx-auto" />
              <p className="font-medium">Plans recorded for {lease.token_number}</p>
              <p className="text-xs text-muted-foreground">
                Transfers appear in the queue below. After stock arrives, use Issue device to issue serials.
              </p>
              <Button variant="outline" onClick={resetTokenWizard}>
                Plan for another token
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Center Operations Queue</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-2">
              <p className="text-sm font-medium">Dispatch from {centerName}</p>
              <Button variant="outline" size="sm" onClick={loadQueue} disabled={queueLoading}>
                {queueLoading ? "Refreshing..." : "Refresh"}
              </Button>
            </div>
            {queueLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
                <span className="ml-2 text-sm text-muted-foreground">Loading queue...</span>
              </div>
            ) : queueError ? (
              <div className="text-center py-8">
                <p className="text-sm text-destructive">{queueError}</p>
                <Button variant="outline" size="sm" onClick={loadQueue} className="mt-2">
                  Retry
                </Button>
              </div>
            ) : outgoingQueue.length === 0 ? (
              <p className="text-sm text-muted-foreground">No pending dispatch tasks.</p>
            ) : (
              <div className="space-y-2">
                {outgoingQueue.map((t) => {
                  const asset = assetsById[t.asset_id];
                  const skuName = asset ? skuNameById[asset.sku_id] ?? "Unknown SKU" : "Unknown SKU";
                  const toName = centers.find((c) => c.id === t.to_center_id)?.name ?? "Destination";
                  const homeName = asset?.home_center_id ? centers.find((c) => c.id === asset.home_center_id)?.name ?? "Unknown owner" : null;
                  const submitting = isSubmitting[t.id] || false;
                  return (
                    <div key={t.id} className="rounded border p-3 text-sm flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                      <div>
                        <p className="font-medium">
                          {asset?.serial_number ?? "Asset"} - {skuName}
                        </p>
                        <p className="text-muted-foreground">To: {toName}</p>
                        {homeName && (
                          <p className="text-xs text-muted-foreground">Home center: {homeName}</p>
                        )}
                        {t.transfer_reason === "fulfillment_transfer" && (
                          <p className="text-xs text-muted-foreground">Temporary fulfillment transfer</p>
                        )}
                      </div>
                      <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full lg:w-auto">
                        <div className="w-full sm:w-72">
                          <SerialNumberInput
                            value={dispatchSerialByTransfer[t.id] ?? ""}
                            onChange={(value) =>
                              setDispatchSerialByTransfer((prev) => ({ ...prev, [t.id]: value }))
                            }
                            onScanned={(value) =>
                              setDispatchSerialByTransfer((prev) => ({ ...prev, [t.id]: value }))
                            }
                            placeholder="Scan serial"
                            disabled={submitting}
                          />
                        </div>
                        <Button size="sm" onClick={() => handleDispatch(t)} disabled={submitting}>
                          {submitting ? "Dispatching..." : "Mark Dispatched"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div>
            <p className="text-sm font-medium mb-2">Receive at {centerName}</p>
            {queueLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
                <span className="ml-2 text-sm text-muted-foreground">Loading queue...</span>
              </div>
            ) : queueError ? (
              <div className="text-center py-8">
                <p className="text-sm text-destructive">{queueError}</p>
                <Button variant="outline" size="sm" onClick={loadQueue} className="mt-2">
                  Retry
                </Button>
              </div>
            ) : incomingQueue.length === 0 ? (
              <p className="text-sm text-muted-foreground">No incoming transfers to receive.</p>
            ) : (
              <div className="space-y-2">
                {incomingQueue.map((t) => {
                  const asset = assetsById[t.asset_id];
                  const skuName = asset ? skuNameById[asset.sku_id] ?? "Unknown SKU" : "Unknown SKU";
                  const fromName = centers.find((c) => c.id === t.from_center_id)?.name ?? "Source";
                  const homeName = asset?.home_center_id ? centers.find((c) => c.id === asset.home_center_id)?.name ?? "Unknown owner" : null;
                  const submitting = isSubmitting[t.id] || false;
                  return (
                    <div key={t.id} className="rounded border p-3 text-sm flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                      <div>
                        <p className="font-medium">
                          {asset?.serial_number ?? "Asset"} - {skuName}
                        </p>
                        <p className="text-muted-foreground">From: {fromName}</p>
                        {homeName && (
                          <p className="text-xs text-muted-foreground">Home center: {homeName}</p>
                        )}
                        {t.transfer_reason === "fulfillment_transfer" && (
                          <p className="text-xs text-muted-foreground">Temporary fulfillment transfer</p>
                        )}
                      </div>
                      <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full lg:w-auto">
                        <div className="w-full sm:w-72">
                          <SerialNumberInput
                            value={receiveSerialByTransfer[t.id] ?? ""}
                            onChange={(value) =>
                              setReceiveSerialByTransfer((prev) => ({ ...prev, [t.id]: value }))
                            }
                            onScanned={(value) =>
                              setReceiveSerialByTransfer((prev) => ({ ...prev, [t.id]: value }))
                            }
                            placeholder="Scan serial"
                            disabled={submitting}
                          />
                        </div>
                        <Button
                          size="sm"
                          className="bg-success hover:bg-success/90 text-success-foreground"
                          onClick={() => handleReceive(t)}
                          disabled={submitting}
                        >
                          {submitting ? "Receiving..." : "Mark Received"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
