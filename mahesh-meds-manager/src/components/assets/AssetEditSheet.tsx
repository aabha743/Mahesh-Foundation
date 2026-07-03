import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api";
import { dbAssetStatusToUi, uiAssetStatusToDb } from "@/lib/assetStatus";
import type { AssetView } from "@/lib/uiTypes";
import { toast } from "sonner";

const assetEditStatusOptions = [
  { value: "available", label: "Available" },
  { value: "leased", label: "Leased" },
  { value: "under_repair", label: "Under Repair" },
  { value: "retired", label: "Retired" },
] as const;

type AssetEditSheetProps = {
  asset: AssetView | null;
  centerOptions: Array<{ id: string; name: string }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: (asset: AssetView) => void;
};

export function AssetEditSheet({ asset, centerOptions, open, onOpenChange, onUpdated }: AssetEditSheetProps) {
  const [status, setStatus] = useState<string>("available");
  const [centerId, setCenterId] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const centerNameById = useMemo(
    () => Object.fromEntries(centerOptions.map((center) => [center.id, center.name])),
    [centerOptions],
  );

  useEffect(() => {
    if (!asset || !open) return;
    setStatus(uiAssetStatusToDb(asset.status));
    const matchingCenter = centerOptions.find((center) => center.name === asset.assignedCenter);
    setCenterId(matchingCenter?.id ?? "");
    setNotes(asset.notes ?? "");
  }, [asset, centerOptions, open]);

  async function handleSave() {
    if (!asset) return;
    setSaving(true);
    try {
      const updated = await apiFetch<{
        id: string;
        serial_number: string;
        sku_id: string;
        center_id: string | null;
        home_center_id: string | null;
        status: string;
        purchase_date: string | null;
        warranty_expiry: string | null;
        notes: string | null;
      }>(`/api/v1/assets/${asset.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status,
          center_id: centerId || undefined,
          notes,
        }),
      });

      onUpdated({
        ...asset,
        assignedCenter: updated.center_id ? centerNameById[updated.center_id] ?? asset.assignedCenter : "Unassigned",
        homeCenter: updated.home_center_id ? centerNameById[updated.home_center_id] ?? asset.homeCenter : asset.homeCenter,
        status: dbAssetStatusToUi(updated.status),
        notes: updated.notes ?? "",
      });
      toast.success(`Updated ${asset.serialNumber}`);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update asset");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Edit Asset</SheetTitle>
          <SheetDescription>
            Update the current location, status, or notes for {asset?.serialNumber ?? "this asset"}.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 mt-6">
          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger><SelectValue placeholder="Select status" /></SelectTrigger>
              <SelectContent>
                {assetEditStatusOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Current Location</Label>
            <Select value={centerId} onValueChange={setCenterId}>
              <SelectTrigger><SelectValue placeholder="Select center" /></SelectTrigger>
              <SelectContent>
                {centerOptions.map((center) => (
                  <SelectItem key={center.id} value={center.id}>
                    {center.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea
              placeholder="Optional notes about this asset"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={5}
            />
          </div>
          <div className="flex flex-col md:flex-row gap-3 pt-4">
            <Button onClick={() => void handleSave()} className="flex-1 w-full md:w-auto" disabled={saving}>
              {saving ? "Saving..." : "Save changes"}
            </Button>
            <Button variant="outline" onClick={() => onOpenChange(false)} className="flex-1 w-full md:w-auto">
              Cancel
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
