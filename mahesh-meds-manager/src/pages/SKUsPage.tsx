import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";

type SKUCategory = "Mobility Aid" | "Respiratory" | "Monitoring" | "Rehabilitation" | "Other";
type SkuApi = {
  id: string;
  name: string;
  sku_code: string;
  category: string | null;
  description: string | null;
  image_url: string | null;
  is_active: boolean;
};

type SkuRow = {
  id: string;
  code: string;
  name: string;
  category: string;
  description: string;
  total: number;
  available: number;
  leased: number;
  color: string;
};

const skuCategories: SKUCategory[] = ["Mobility Aid", "Respiratory", "Monitoring", "Rehabilitation", "Other"];

export default function SKUsPage() {
  const { can } = useAuth();
  const [skus, setSkus] = useState<SkuRow[]>([]);
  const [rawSkus, setRawSkus] = useState<SkuApi[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [form, setForm] = useState({ code: "", name: "", category: "" as SKUCategory | "", description: "", imageUrl: "" });

  useEffect(() => {
    // Loads SKU master data and derives stock counters from assets.
    async function loadSkus() {
      try {
        const [skuList, assetList] = await Promise.all([
          apiFetch<SkuApi[]>("/api/v1/skus"),
          apiFetch<Array<{ sku_id: string; status: string }>>("/api/v1/assets"),
        ]);
        const stockBySku: Record<string, { total: number; available: number; leased: number }> = {};
        for (const asset of assetList) {
          if (!stockBySku[asset.sku_id]) stockBySku[asset.sku_id] = { total: 0, available: 0, leased: 0 };
          stockBySku[asset.sku_id].total += 1;
          if (asset.status === "available") stockBySku[asset.sku_id].available += 1;
          if (asset.status === "leased") stockBySku[asset.sku_id].leased += 1;
        }
        const mapped = skuList.map((sku) => ({
          id: sku.id,
          code: sku.sku_code,
          name: sku.name,
          category: sku.category ?? "Other",
          description: sku.description ?? "",
          total: stockBySku[sku.id]?.total ?? 0,
          available: stockBySku[sku.id]?.available ?? 0,
          leased: stockBySku[sku.id]?.leased ?? 0,
          color: `hsl(${Math.abs(sku.name.split("").reduce((n, ch) => n + ch.charCodeAt(0), 0)) % 360}, 70%, 50%)`,
        }));
        setRawSkus(skuList);
        setSkus(mapped);
      } catch {
        toast.error("Could not load SKUs");
      }
    }
    void loadSkus();
  }, []);

  const skuIdByCode = useMemo(
    () => Object.fromEntries(rawSkus.map((s) => [s.sku_code, s.id])),
    [rawSkus],
  );

  const handleSave = async () => {
    // Creates a new SKU in backend and appends it in UI list.
    if (!form.code || !form.name || !form.category) {
      toast.error("Please fill required fields");
      return;
    }
    if (skuIdByCode[form.code]) {
      toast.error("SKU code already exists");
      return;
    }
    setIsSaving(true);
    try {
      const created = await apiFetch<SkuApi>("/api/v1/skus", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          sku_code: form.code,
          category: form.category,
          description: form.description || null,
          image_url: form.imageUrl.trim() || null,
          is_active: true,
        }),
      });
      setRawSkus((prev) => [created, ...prev]);
      setSkus((prev) => [
        {
          id: created.id,
          code: created.sku_code,
          name: created.name,
          category: created.category ?? "Other",
          description: created.description ?? "",
          total: 0,
          available: 0,
          leased: 0,
          color: `hsl(${Math.abs(created.name.split("").reduce((n, ch) => n + ch.charCodeAt(0), 0)) % 360}, 70%, 50%)`,
        },
        ...prev,
      ]);
      setModalOpen(false);
      setForm({ code: "", name: "", category: "", description: "", imageUrl: "" });
      toast.success("SKU added successfully");
    } catch {
      toast.error("Failed to add SKU");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteSku = async (sku: SkuRow) => {
    if (!window.confirm(`Delete SKU ${sku.name}?`)) return;
    try {
      await apiFetch(`/api/v1/skus/${sku.id}`, { method: "DELETE" });
      setRawSkus((prev) => prev.filter((item) => item.id !== sku.id));
      setSkus((prev) => prev.filter((item) => item.id !== sku.id));
      toast.success(`Deleted ${sku.name}`);
    } catch {
      toast.error("Failed to delete SKU");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-muted-foreground">{skus.length} device types registered</p>
        {/* Master admin SKU page no longer creates SKUs directly here. */}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {skus.map((sku) => (
          <Card key={sku.id} className="hover:shadow-md transition-shadow">
            <CardContent className="p-5">
              <div className="flex items-start gap-3 mb-3">
                <div className="h-10 w-10 rounded-lg flex items-center justify-center text-primary-foreground text-sm font-bold shrink-0" style={{ backgroundColor: sku.color }}>
                  {sku.name.charAt(0)}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-foreground truncate">{sku.name}</h3>
                  <p className="text-xs text-muted-foreground font-mono">{sku.code}</p>
                </div>
                {can("skus.manage") && (
                  <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-destructive hover:text-destructive" onClick={() => void handleDeleteSku(sku)} title="Delete SKU">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
              <Badge variant="secondary" className="mb-3">{sku.category}</Badge>
              <p className="text-xs text-muted-foreground mb-3 line-clamp-2">{sku.description}</p>
              <div className="grid grid-cols-3 gap-2 text-center border-t border-border pt-3">
                <div>
                  <p className="text-lg font-bold text-foreground">{sku.total}</p>
                  <p className="text-[10px] text-muted-foreground">Total</p>
                </div>
                <div>
                  <p className="text-lg font-bold text-success">{sku.available}</p>
                  <p className="text-[10px] text-muted-foreground">Available</p>
                </div>
                <div>
                  <p className="text-lg font-bold text-warning">{sku.leased}</p>
                  <p className="text-[10px] text-muted-foreground">Leased</p>
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-border text-xs text-muted-foreground">
                Status: <span className="font-semibold text-foreground">{sku.total > 0 ? "Stocked" : "No stock yet"}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="w-full max-w-lg mx-4 md:mx-auto">
          <DialogHeader>
            <DialogTitle>Add New SKU</DialogTitle>
            <DialogDescription>Create a new device type for the inventory</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2"><Label>SKU Code *</Label><Input placeholder="e.g. SKU-XX-YYY" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></div>
              <div className="space-y-2"><Label>Device Name *</Label><Input placeholder="e.g. Pulse Oximeter" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            </div>
            <div className="space-y-2">
              <Label>Category *</Label>
              <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v as SKUCategory })}>
                <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                <SelectContent>{skuCategories.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Image URL</Label>
              <Input
                placeholder="https://example.com/device-image.jpg"
                value={form.imageUrl}
                onChange={(e) => setForm({ ...form, imageUrl: e.target.value })}
              />
            </div>
            <div className="space-y-2"><Label>Description</Label><Textarea placeholder="Brief description..." value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
            <div className="flex flex-col md:flex-row gap-3 pt-2">
              <Button onClick={() => void handleSave()} className="flex-1 w-full md:w-auto" disabled={isSaving}>{isSaving ? "Saving..." : "Save SKU"}</Button>
              <Button variant="outline" onClick={() => setModalOpen(false)} className="flex-1 w-full md:w-auto">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
