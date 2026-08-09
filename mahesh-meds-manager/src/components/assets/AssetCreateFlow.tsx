import { useEffect, useState } from "react";
import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { AssetSuccessModal } from "@/components/AssetSuccessModal";
import { apiFetch } from "@/lib/api";
import { dbAssetStatusToUi, uiAssetStatusToDb } from "@/lib/assetStatus";
import { assetStatusOptions, type AssetStatus, type AssetView } from "@/lib/uiTypes";
import { toast } from "sonner";

type AssetCreateFlowProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (asset: AssetView) => void;
  onDone?: () => void;
};

export function AssetCreateFlow({ open, onOpenChange, onCreated, onDone }: AssetCreateFlowProps) {
  const [skuOptions, setSkuOptions] = useState<string[]>([]);
  const [centerOptions, setCenterOptions] = useState<string[]>([]);
  const [skuNameToId, setSkuNameToId] = useState<Record<string, string>>({});
  const [centerNameToId, setCenterNameToId] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [purchaseDate, setPurchaseDate] = useState<Date>();
  const [warrantyDate, setWarrantyDate] = useState<Date>();
  const [successModalOpen, setSuccessModalOpen] = useState(false);
  const [createdAsset, setCreatedAsset] = useState<{
    serialNumber: string;
    skuName: string;
    centerName: string;
  } | null>(null);
  const [formData, setFormData] = useState({
    skuName: "",
    assignedCenter: "",
    status: "" as AssetStatus | "",
    notes: "",
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function loadOptions() {
      try {
        const [centers, skus] = await Promise.all([
          apiFetch<Array<{ id: string; name: string }>>("/api/v1/centers"),
          apiFetch<Array<{ id: string; name: string }>>("/api/v1/skus"),
        ]);
        if (cancelled) return;
        setSkuOptions(skus.map((sku) => sku.name));
        setCenterOptions(centers.map((center) => center.name));
        setSkuNameToId(Object.fromEntries(skus.map((sku) => [sku.name, sku.id])));
        setCenterNameToId(Object.fromEntries(centers.map((center) => [center.name, center.id])));
      } catch {
        if (!cancelled) {
          toast.error("Could not load asset form options");
        }
      }
    }

    void loadOptions();
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function handleSave() {
    if (!formData.skuName || !formData.assignedCenter || !formData.status) {
      toast.error("Please fill all required fields");
      return;
    }

    const skuId = skuNameToId[formData.skuName];
    const centerId = centerNameToId[formData.assignedCenter];
    if (!skuId || !centerId) {
      toast.error("Invalid SKU or center selection");
      return;
    }

    setIsSaving(true);
    try {
      const created = await apiFetch<{
        id: string;
        serial_number: string;
        status: string;
        purchase_date: string | null;
        warranty_expiry: string | null;
        notes: string | null;
      }>("/api/v1/assets", {
        method: "POST",
        body: JSON.stringify({
          sku_id: skuId,
          center_id: centerId,
          status: uiAssetStatusToDb(formData.status as AssetStatus),
          purchase_date: purchaseDate ? format(purchaseDate, "yyyy-MM-dd") : null,
          warranty_expiry: warrantyDate ? format(warrantyDate, "yyyy-MM-dd") : null,
          notes: formData.notes || null,
        }),
      });

      const newAsset: AssetView = {
        id: created.id,
        serialNumber: created.serial_number,
        skuName: formData.skuName,
        assignedCenter: formData.assignedCenter,
        homeCenter: formData.assignedCenter,
        status: dbAssetStatusToUi(created.status),
        purchaseDate: created.purchase_date ?? "",
        warrantyExpiry: created.warranty_expiry ?? "",
        notes: created.notes ?? "",
      };
      onCreated?.(newAsset);
      setCreatedAsset({
        serialNumber: created.serial_number,
        skuName: formData.skuName,
        centerName: formData.assignedCenter,
      });
      setSuccessModalOpen(true);
      setFormData({ skuName: "", assignedCenter: "", status: "", notes: "" });
      setPurchaseDate(undefined);
      setWarrantyDate(undefined);
      onOpenChange(false);
      toast.success("Asset added successfully");
    } catch {
      toast.error("Failed to add asset");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Add New Asset</SheetTitle>
            <SheetDescription>Register a new medical device asset</SheetDescription>
          </SheetHeader>
          <div className="space-y-4 mt-6">
            <div className="space-y-2">
              <Label>Serial Number</Label>
              <Input value="Generated automatically after save" disabled />
            </div>
            <div className="space-y-2">
              <Label>SKU *</Label>
              <Select value={formData.skuName} onValueChange={(value) => setFormData((current) => ({ ...current, skuName: value }))}>
                <SelectTrigger><SelectValue placeholder="Select SKU" /></SelectTrigger>
                <SelectContent>{skuOptions.map((sku) => <SelectItem key={sku} value={sku}>{sku}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Assigned Center *</Label>
              <Select value={formData.assignedCenter} onValueChange={(value) => setFormData((current) => ({ ...current, assignedCenter: value }))}>
                <SelectTrigger><SelectValue placeholder="Select Center" /></SelectTrigger>
                <SelectContent>{centerOptions.map((center) => <SelectItem key={center} value={center}>{center}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Purchase Date</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-full justify-start text-left font-normal", !purchaseDate && "text-muted-foreground")}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {purchaseDate ? format(purchaseDate, "PPP") : "Pick a date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={purchaseDate} onSelect={setPurchaseDate} initialFocus className="p-3 pointer-events-auto" />
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-2">
              <Label>Warranty Expiry</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-full justify-start text-left font-normal", !warrantyDate && "text-muted-foreground")}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {warrantyDate ? format(warrantyDate, "PPP") : "Pick a date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={warrantyDate} onSelect={setWarrantyDate} initialFocus className="p-3 pointer-events-auto" />
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-2">
              <Label>Status *</Label>
              <Select value={formData.status} onValueChange={(value) => setFormData((current) => ({ ...current, status: value as AssetStatus }))}>
                <SelectTrigger><SelectValue placeholder="Select asset status" /></SelectTrigger>
                <SelectContent>{assetStatusOptions.map((status) => <SelectItem key={status} value={status}>{status}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea placeholder="Optional notes..." value={formData.notes} onChange={(e) => setFormData((current) => ({ ...current, notes: e.target.value }))} />
            </div>
            <div className="flex gap-3 pt-4">
              <Button onClick={() => void handleSave()} className="flex-1" disabled={isSaving}>
                {isSaving ? "Saving..." : "Save Asset"}
              </Button>
              <Button variant="outline" onClick={() => onOpenChange(false)} className="flex-1">Cancel</Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <AssetSuccessModal
        open={successModalOpen}
        onClose={() => {
          setSuccessModalOpen(false);
          onDone?.();
        }}
        assetData={createdAsset}
        onPrintSticker={() => undefined}
        onAddAnother={() => {
          setSuccessModalOpen(false);
          onOpenChange(true);
          if (createdAsset) {
            setFormData((current) => ({ ...current, skuName: createdAsset.skuName }));
          }
        }}
      />
    </>
  );
}
