import { useMemo, useState } from "react";
import { Search, CheckCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { useCenterScope } from "@/hooks/useCenterScope";
import { apiFetch } from "@/lib/api";
import { uiAssetStatusToDb } from "@/lib/assetStatus";
import type { AssetStatus } from "@/lib/uiTypes";
import { toast } from "sonner";
import { SerialNumberInput } from "@/components/SerialNumberInput";

const steps = ["Find Request", "Return Condition"];
const conditions = ["Good", "Minor Damage", "Major Damage", "Needs Repair"];
const checklist = ["Device is functional", "All accessories returned", "No physical damage", "Device cleaned/sanitized"];

type AssetRow = {
  id: string;
  serial_number: string;
  sku_id: string;
  center_id: string | null;
  home_center_id: string | null;
  status: string;
};

type LeaseRequestRow = {
  id: string;
  token_number: string;
  requestor_name: string;
  preferred_center_id: string | null;
  status: string;
  skus: string[];
  items?: Array<{ sku_id: string; sku_name: string; quantity_requested: number; asset_id?: string | null }>;
};

export default function ReturnDevice() {
  const { centerId } = useCenterScope();
  const [step, setStep] = useState(0);
  const [token, setToken] = useState("");
  const [lease, setLease] = useState<LeaseRequestRow | null>(null);
  const [assetsById, setAssetsById] = useState<Record<string, AssetRow>>({});
  const [selectedItemKeys, setSelectedItemKeys] = useState<Record<string, boolean>>({});
  const [confirmSerialByKey, setConfirmSerialByKey] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [checks, setChecks] = useState<boolean[]>([false, false, false, false]);
  const [condition, setCondition] = useState("");
  const [notes, setNotes] = useState("");
  const [completed, setCompleted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const returnableItems = useMemo(() => {
    if (!lease) return [];
    const items = lease.items ?? [];
    return items
      .map((item, idx) => ({ ...item, key: `${item.sku_id}-${idx}` }))
      .filter((item) => {
        if (!item.asset_id) return false;
        const asset = assetsById[item.asset_id];
        if (!asset || asset.status !== "leased") return false;
        const assetLeaseCenterId = asset.home_center_id ?? asset.center_id;
        return !!assetLeaseCenterId && assetLeaseCenterId === centerId;
      });
  }, [lease, assetsById, centerId]);

  const handleFind = async () => {
    if (!centerId) return;
    setError("");
    try {
      const [leaseByToken, assets] = await Promise.all([
        apiFetch<LeaseRequestRow>(`/api/v1/lease-requests/by-token/${encodeURIComponent(token.trim())}`),
        apiFetch<AssetRow[]>("/api/v1/assets"),
      ]);
      const nextAssetsById = Object.fromEntries(assets.map((a) => [a.id, a]));
      const itemsAtThisCenter = (leaseByToken.items ?? []).some((item) => {
        if (!item.asset_id) return false;
        const asset = nextAssetsById[item.asset_id];
        if (!asset || asset.status !== "leased") return false;
        const assetLeaseCenterId = asset.home_center_id ?? asset.center_id;
        return !!assetLeaseCenterId && assetLeaseCenterId === centerId;
      });
      if (!itemsAtThisCenter) {
        setError("No issued items from this center were found for this token.");
        setLease(null);
        return;
      }
      setLease(leaseByToken);
      setAssetsById(nextAssetsById);
      setSelectedItemKeys({});
      setConfirmSerialByKey({});
      if (leaseByToken.status !== "active") {
        setError("This lease is not active. Return is recommended for active leases.");
      }
    } catch {
      setError("Could not find lease request by token.");
      setLease(null);
    }
  };

  const toggleCheck = (i: number) => setChecks((p) => p.map((v, idx) => (idx === i ? !v : v)));

  const handleComplete = async () => {
    if (!lease) return;
    const nextStatus: AssetStatus = condition === "Needs Repair" ? "Under Repair" : "Available";
    setSubmitting(true);
    try {
      const selected = returnableItems.filter((item) => selectedItemKeys[item.key]);
      if (!selected.length) {
        toast.error("Select at least one item to return");
        setSubmitting(false);
        return;
      }
      for (const item of selected) {
        if (!item.asset_id) continue;
        const asset = assetsById[item.asset_id];
        if (!asset) continue;
        const scanned = (confirmSerialByKey[item.key] ?? "").trim().toUpperCase();
        if (scanned !== asset.serial_number.toUpperCase()) {
          throw new Error(`Serial mismatch for ${item.sku_name}`);
        }
        await apiFetch(`/api/v1/assets/${asset.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            status: uiAssetStatusToDb(nextStatus),
            center_id: centerId,
            notes: notes || null,
          }),
        });
      }

      // Get fresh asset data after updates
      const refreshedAssets = await apiFetch<AssetRow[]>("/api/v1/assets");
      const refreshedMap = Object.fromEntries(refreshedAssets.map((a) => [a.id, a]));
      setAssetsById(refreshedMap);

      // Check which items were successfully returned vs still leased
      const successfullyReturned = selected.filter(item => {
        if (!item.asset_id) return false;
        const asset = refreshedMap[item.asset_id];
        return asset && asset.status !== "leased";
      });

      const stillLeasedItems = (lease.items ?? []).filter(item => {
        if (!item.asset_id) return false;
        // Check if this item was NOT in the successfully returned list
        const wasReturned = successfullyReturned.some(returned => 
          returned.sku_id === item.sku_id && returned.asset_id === item.asset_id
        );
        const asset = refreshedMap[item.asset_id];
        return !wasReturned && asset && asset.status === "leased";
      });

      // Only update lease status if we have a clear state
      if (stillLeasedItems.length === 0 && successfullyReturned.length > 0) {
        // All items returned successfully
        await apiFetch(`/api/v1/lease-requests/${lease.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "closed" }),
        });
      } else if (successfullyReturned.length > 0) {
        // Partial return - keep active
        await apiFetch(`/api/v1/lease-requests/${lease.id}`, {
          method: "PATCH",
          body: JSON.stringify({ 
            status: "active",
            notes: `Partial return: ${successfullyReturned.length} items returned, ${stillLeasedItems.length} still leased`
          }),
        });
      }
      // If no items were successfully returned, don't change lease status

      setCompleted(true);
      toast.success("Return recorded");
    } catch {
      toast.error("Failed to complete token return");
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

      {!completed && step === 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step 1: Find Lease Request</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-2">
              <Input placeholder="Enter Lease Token..." value={token} onChange={(e) => setToken(e.target.value)} />
              <Button onClick={handleFind}>
                <Search className="h-4 w-4 mr-1" /> Find
              </Button>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {lease && (
              <div className="border rounded-lg p-4 space-y-2 text-sm">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <div>
                    <span className="text-muted-foreground">Token:</span> {lease.token_number}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Requestor:</span> {lease.requestor_name}
                  </div>
                </div>
                <Badge variant="outline" className="bg-warning/15 text-warning border-warning/30">{lease.status}</Badge>
                <div className="space-y-2">
                  {returnableItems.length === 0 && (
                    <p className="text-xs text-muted-foreground">No currently leased items under this token.</p>
                  )}
                  {returnableItems.map((item) => {
                    const asset = item.asset_id ? assetsById[item.asset_id] : null;
                    return (
                      <div key={item.key} className="rounded border p-2 space-y-2">
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                          <label className="flex items-center gap-2 text-sm">
                            <Checkbox
                              checked={!!selectedItemKeys[item.key]}
                              onCheckedChange={(checked) =>
                                setSelectedItemKeys((prev) => ({ ...prev, [item.key]: Boolean(checked) }))
                              }
                            />
                            <span>{item.sku_name}</span>
                          </label>
                          <span className="text-xs text-muted-foreground font-mono">{asset?.serial_number}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div>
                  <Button onClick={() => setStep(1)} disabled={returnableItems.length === 0}>
                    Proceed to Return
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!completed && step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step 2: Return Condition</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              {checklist.map((label, i) => (
                <div key={label} className="flex items-center gap-2">
                  <Checkbox checked={checks[i]} onCheckedChange={() => toggleCheck(i)} />
                  <span className="text-sm">{label}</span>
                </div>
              ))}
            </div>
            <Select value={condition} onValueChange={setCondition}>
              <SelectTrigger>
                <SelectValue placeholder="Select condition" />
              </SelectTrigger>
              <SelectContent>
                {conditions.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {condition === "Needs Repair" && <p className="text-xs text-warning">Asset will be marked as Under Repair</p>}
            <div className="space-y-2">
              <p className="text-sm font-medium">Confirm serials for selected items</p>
              {returnableItems.filter((item) => selectedItemKeys[item.key]).map((item) => (
                <div key={item.key} className="grid grid-cols-1 md:grid-cols-2 gap-2 items-center">
                  <div className="text-sm">
                    {item.sku_name}{" "}
                    <span className="text-xs text-muted-foreground">
                      ({item.asset_id ? assetsById[item.asset_id]?.serial_number : "N/A"})
                    </span>
                  </div>
                  <SerialNumberInput
                    value={confirmSerialByKey[item.key] ?? ""}
                    onChange={(value) => setConfirmSerialByKey((prev) => ({ ...prev, [item.key]: value }))}
                    onScanned={(value) => setConfirmSerialByKey((prev) => ({ ...prev, [item.key]: value }))}
                    placeholder="Scan/enter serial to confirm"
                  />
                </div>
              ))}
            </div>
            <Textarea placeholder="Notes or remarks..." value={notes} onChange={(e) => setNotes(e.target.value)} />
            <div className="flex flex-col sm:flex-row gap-2">
              <Button variant="outline" onClick={() => setStep(0)}>
                Back
              </Button>
              <Button
                className="bg-success hover:bg-success/90 text-success-foreground"
                onClick={handleComplete}
                disabled={!condition || submitting || !returnableItems.some((item) => selectedItemKeys[item.key])}
              >
                {submitting ? "Saving..." : "Complete Return"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {completed && lease && (
        <Card className="text-center">
          <CardContent className="py-10 space-y-4">
            <CheckCircle className="h-16 w-16 text-success mx-auto" />
            <h2 className="text-xl font-semibold text-foreground">Return Recorded!</h2>
            <div className="border rounded-lg p-4 text-sm text-left max-w-sm mx-auto space-y-1">
              <p>
                <span className="text-muted-foreground">Token:</span> {lease.token_number}
              </p>
              <p>
                <span className="text-muted-foreground">Requestor:</span> {lease.requestor_name}
              </p>
              <p>
                <span className="text-muted-foreground">Condition:</span> {condition}
              </p>
              <p>
                <span className="text-muted-foreground">New Status:</span> {condition === "Needs Repair" ? "Under Repair" : "Available"}
              </p>
            </div>
            <Button
              onClick={() => {
                setStep(0);
                setToken("");
                setLease(null);
                setAssetsById({});
                setSelectedItemKeys({});
                setConfirmSerialByKey({});
                setChecks([false, false, false, false]);
                setCondition("");
                setNotes("");
                setCompleted(false);
              }}
            >
              Return Another
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
