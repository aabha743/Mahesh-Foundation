import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Phone, MapPin, User, ArrowLeft, Package } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Center = {
  id: string;
  name: string;
  city: string;
  state: string;
  address: string;
  pinCode: string;
  adminName: string;
  contactPhone: string;
  totalAssets: number;
  activeLeases: number;
  staff: number;
  isActive: boolean;
};

type SkuApi = {
  id: string;
  name: string;
  sku_code: string;
  category: string | null;
  description: string | null;
  image_url: string | null;
  is_active: boolean;
};
type AssetApi = {
  id: string;
  serial_number: string;
  sku_id: string;
  center_id: string | null;
  home_center_id?: string | null;
  status: string;
  purchase_date?: string | null;
  warranty_expiry?: string | null;
  invoice_number?: string | null;
  invoice_url?: string | null;
  qr_code?: string | null;
  notes?: string | null;
};

export default function CentersPage() {
  const { can } = useAuth();
  const [centers, setCenters] = useState<Center[]>([]);
  const [assets, setAssets] = useState<AssetApi[]>([]);
  const [skus, setSkus] = useState<SkuApi[]>([]);
  const [selectedCenterId, setSelectedCenterId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editDrawerOpen, setEditDrawerOpen] = useState(false);
  const [skuDrawerOpen, setSkuDrawerOpen] = useState(false);
  const [editSkuDrawerOpen, setEditSkuDrawerOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [form, setForm] = useState({ name: "", address: "", city: "", state: "", pinCode: "", contactPerson: "", contactPhone: "", isActive: true });
  const [editingCenterId, setEditingCenterId] = useState<string>("");
  const [editForm, setEditForm] = useState({ name: "", address: "", city: "", state: "", pinCode: "", contactPerson: "", contactPhone: "", isActive: true });
  const [skuForm, setSkuForm] = useState({
    name: "",
    skuCode: "",
    category: "",
    description: "",
    imageUrl: "",
    isActive: true,
    initialQuantity: "1",
    assetStatus: "available",
    purchaseDate: "",
    warrantyExpiry: "",
    invoiceNumber: "",
    invoiceUrl: "",
    qrCodePrefix: "",
    assetNotes: "",
  });
  const [editingSkuId, setEditingSkuId] = useState<string>("");
  const [editSkuForm, setEditSkuForm] = useState({
    name: "",
    skuCode: "",
    category: "",
    description: "",
    imageUrl: "",
    isActive: true,
    addQuantity: "0",
    assetStatus: "available",
    purchaseDate: "",
    warrantyExpiry: "",
    invoiceNumber: "",
    invoiceUrl: "",
    qrCodePrefix: "",
    assetNotes: "",
  });

  useEffect(() => {
    // Loads centers with related inventory/request counts for admin overview cards.
    async function loadCenters() {
      try {
        const [centersResp, assetsResp, skusResp, leaseResp] = await Promise.all([
          apiFetch<Array<{
            id: string;
            name: string;
            city: string | null;
            state: string | null;
            address: string | null;
            pin_code: string | null;
            contact_person: string | null;
            contact_phone: string | null;
            is_active: boolean;
          }>>("/api/v1/centers"),
          apiFetch<Array<AssetApi>>("/api/v1/assets"),
          apiFetch<Array<SkuApi>>("/api/v1/skus"),
          apiFetch<Array<{ status: string; items?: Array<{ asset_id: string | null }> }>>("/api/v1/lease-requests"),
        ]);

        const assetsByCenter: Record<string, number> = {};
        assetsResp.forEach((asset) => {
          if (!asset.center_id) return;
          assetsByCenter[asset.center_id] = (assetsByCenter[asset.center_id] ?? 0) + 1;
        });

        const activeLeasesByCenter: Record<string, number> = {};
        const assetsById = Object.fromEntries(assetsResp.map((asset) => [asset.id, asset]));
        leaseResp.forEach((lease) => {
          if (lease.status !== "active") return;
          const touchedCenters = new Set<string>();
          for (const item of lease.items ?? []) {
            if (!item.asset_id) continue;
            const asset = assetsById[item.asset_id];
            const leaseCenterId = asset?.home_center_id ?? asset?.center_id;
            if (leaseCenterId) touchedCenters.add(leaseCenterId);
          }
          touchedCenters.forEach((centerId) => {
            activeLeasesByCenter[centerId] = (activeLeasesByCenter[centerId] ?? 0) + 1;
          });
        });

        const uiCenters: Center[] = centersResp.map((center) => ({
          id: center.id,
          name: center.name,
          city: center.city ?? "",
          state: center.state ?? "",
          address: center.address ?? "",
          pinCode: center.pin_code ?? "",
          adminName: center.contact_person ?? "",
          contactPhone: center.contact_phone ?? "",
          totalAssets: assetsByCenter[center.id] ?? 0,
          activeLeases: activeLeasesByCenter[center.id] ?? 0,
          staff: 0,
          isActive: center.is_active,
        }));

        setCenters(uiCenters);
        setAssets(assetsResp);
        setSkus(skusResp);
      } catch {
        toast.error("Could not load centers from API");
      }
    }

    loadCenters();
  }, []);

  async function reloadInventory() {
    // Refreshes SKU/asset snapshots after stock or SKU metadata updates.
    try {
      const [assetsResp, skusResp] = await Promise.all([
        apiFetch<Array<AssetApi>>("/api/v1/assets"),
        apiFetch<Array<SkuApi>>("/api/v1/skus"),
      ]);
      setAssets(assetsResp);
      setSkus(skusResp);
      setCenters((prev) =>
        prev.map((center) => {
          const totalAssets = assetsResp.filter((a) => a.center_id === center.id).length;
          return { ...center, totalAssets };
        }),
      );
    } catch {
      toast.error("Could not refresh inventory");
    }
  }

  const selectedCenter = centers.find((c) => c.id === selectedCenterId) ?? null;

  const openEditCenter = (center: Center) => {
    setEditingCenterId(center.id);
    setEditForm({
      name: center.name,
      address: center.address,
      city: center.city,
      state: center.state,
      pinCode: center.pinCode,
      contactPerson: center.adminName,
      contactPhone: center.contactPhone,
      isActive: center.isActive,
    });
    setEditDrawerOpen(true);
  };

  const skuRows = useMemo(() => {
    // Builds center-specific SKU inventory aggregates for table display.
    if (!selectedCenterId) return [];
    const assetsAtCenter = assets.filter((a) => a.center_id === selectedCenterId);
    const countBySku: Record<
      string,
      { total: number; available: number; leased: number; underRepair: number; borrowedHere: number }
    > = {};
    for (const asset of assetsAtCenter) {
      if (!countBySku[asset.sku_id]) {
        countBySku[asset.sku_id] = { total: 0, available: 0, leased: 0, underRepair: 0, borrowedHere: 0 };
      }
      countBySku[asset.sku_id].total += 1;
      if (asset.status === "available") countBySku[asset.sku_id].available += 1;
      else if (asset.status === "leased") countBySku[asset.sku_id].leased += 1;
      else if (asset.status === "under_repair" || asset.status === "repair") countBySku[asset.sku_id].underRepair += 1;
      // else if (asset.status === "in_transit") countBySku[asset.sku_id].inTransit += 1;
      if (asset.home_center_id && asset.home_center_id !== selectedCenterId) countBySku[asset.sku_id].borrowedHere += 1;
    }
    return skus
      .filter((s) => countBySku[s.id] || s.is_active)
      .map((sku) => ({
        sku,
        counts: countBySku[sku.id] ?? { total: 0, available: 0, leased: 0, underRepair: 0, borrowedHere: 0 },
      }))
      .sort((a, b) => a.sku.name.localeCompare(b.sku.name));
  }, [selectedCenterId, assets, skus]);

  const openEditSku = (skuId: string) => {
    // Opens edit-stock drawer and pre-fills form from selected SKU.
    const sku = skus.find((s) => s.id === skuId);
    if (!sku) return;
    setEditingSkuId(sku.id);
    setEditSkuForm({
      name: sku.name,
      skuCode: sku.sku_code,
      category: sku.category ?? "",
      description: sku.description ?? "",
      imageUrl: sku.image_url ?? "",
      isActive: sku.is_active,
      addQuantity: "0",
      assetStatus: "available",
      purchaseDate: "",
      warrantyExpiry: "",
      invoiceNumber: "",
      invoiceUrl: "",
      qrCodePrefix: "",
      assetNotes: "",
    });
    setEditSkuDrawerOpen(true);
  };

  const createAssetsForCenter = async (
    skuId: string,
    quantity: number,
    centerId: string,
    codeSeed: string,
    defaults: {
      status: string;
      purchase_date?: string | null;
      warranty_expiry?: string | null;
      invoice_number?: string | null;
      invoice_url?: string | null;
      qr_code?: string | null;
      notes?: string | null;
    },
  ) => {
    // Creates one asset record per requested quantity with generated serial numbers.
    for (let i = 0; i < quantity; i += 1) {
      const serial = `${codeSeed}-${Date.now().toString(36).toUpperCase()}-${(i + 1).toString().padStart(2, "0")}`;
      await apiFetch("/api/v1/assets", {
        method: "POST",
        body: JSON.stringify({
          sku_id: skuId,
          serial_number: serial,
          center_id: centerId,
          status: defaults.status,
          purchase_date: defaults.purchase_date ?? null,
          warranty_expiry: defaults.warranty_expiry ?? null,
          invoice_number: defaults.invoice_number ?? null,
          invoice_url: defaults.invoice_url ?? null,
          qr_code: defaults.qr_code ? `${defaults.qr_code}-${i + 1}` : null,
          notes: defaults.notes ?? null,
        }),
      });
    }
  };

  const handleSave = async () => {
    // Creates a new center from drawer form input.
    if (!form.name || !form.city) { toast.error("Please fill required fields"); return; }

    setIsSaving(true);
    try {
      const created = await apiFetch<{
        id: string;
        name: string;
        city: string | null;
        state: string | null;
        address: string | null;
        pin_code: string | null;
        contact_person: string | null;
        contact_phone: string | null;
        is_active: boolean;
      }>("/api/v1/centers", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          address: form.address || null,
          city: form.city || null,
          state: form.state || "Telangana",
          pin_code: form.pinCode || null,
          contact_person: form.contactPerson || null,
          contact_phone: form.contactPhone || null,
          is_active: form.isActive,
        }),
      });

      const newCenter: Center = {
        id: created.id,
        name: created.name,
        city: created.city ?? "",
        state: created.state ?? "",
        address: created.address ?? "",
        pinCode: created.pin_code ?? "",
        adminName: created.contact_person ?? "",
        contactPhone: created.contact_phone ?? "",
        totalAssets: 0,
        activeLeases: 0,
        staff: 0,
        isActive: created.is_active,
      };
      setCenters((prev) => [newCenter, ...prev]);
      setDrawerOpen(false);
      setForm({ name: "", address: "", city: "", state: "", pinCode: "", contactPerson: "", contactPhone: "", isActive: true });
      toast.success("Center added successfully");
    } catch {
      toast.error("Failed to add center");
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdateCenter = async () => {
    // Updates existing center details from the edit drawer.
    if (!editingCenterId) return;
    if (!editForm.name || !editForm.city) {
      toast.error("Please fill required fields");
      return;
    }

    setIsSaving(true);
    try {
      const updated = await apiFetch<{
        id: string;
        name: string;
        city: string | null;
        state: string | null;
        address: string | null;
        pin_code: string | null;
        contact_person: string | null;
        contact_phone: string | null;
        is_active: boolean;
      }>(`/api/v1/centers/${editingCenterId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editForm.name,
          address: editForm.address || null,
          city: editForm.city || null,
          state: editForm.state || "Telangana",
          pin_code: editForm.pinCode || null,
          contact_person: editForm.contactPerson || null,
          contact_phone: editForm.contactPhone || null,
          is_active: editForm.isActive,
        }),
      });

      setCenters((prev) =>
        prev.map((center) =>
          center.id === updated.id
            ? {
                ...center,
                name: updated.name,
                city: updated.city ?? "",
                state: updated.state ?? "",
                address: updated.address ?? "",
                pinCode: updated.pin_code ?? "",
                adminName: updated.contact_person ?? "",
                contactPhone: updated.contact_phone ?? "",
                isActive: updated.is_active,
              }
            : center,
        ),
      );
      setEditDrawerOpen(false);
      toast.success("Center updated successfully");
    } catch {
      toast.error("Failed to update center");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveSku = async () => {
    // Creates SKU metadata and initial stock at selected center.
    if (!selectedCenterId) return;
    if (!skuForm.name || !skuForm.skuCode) {
      toast.error("SKU name and code are required");
      return;
    }
    const quantity = Math.max(1, Number(skuForm.initialQuantity) || 1);
    setIsSaving(true);
    try {
      const createdSku = await apiFetch<SkuApi>("/api/v1/skus", {
        method: "POST",
        body: JSON.stringify({
          name: skuForm.name,
          sku_code: skuForm.skuCode,
          category: skuForm.category || null,
          description: skuForm.description || null,
          image_url: skuForm.imageUrl || null,
          is_active: skuForm.isActive,
        }),
      });
      await createAssetsForCenter(createdSku.id, quantity, selectedCenterId, createdSku.sku_code, {
        status: skuForm.assetStatus,
        purchase_date: skuForm.purchaseDate || null,
        warranty_expiry: skuForm.warrantyExpiry || null,
        invoice_number: skuForm.invoiceNumber || null,
        invoice_url: skuForm.invoiceUrl || null,
        qr_code: skuForm.qrCodePrefix || null,
        notes: skuForm.assetNotes || null,
      });
      await reloadInventory();
      setSkuDrawerOpen(false);
      setSkuForm({
        name: "",
        skuCode: "",
        category: "",
        description: "",
        imageUrl: "",
        isActive: true,
        initialQuantity: "1",
        assetStatus: "available",
        purchaseDate: "",
        warrantyExpiry: "",
        invoiceNumber: "",
        invoiceUrl: "",
        qrCodePrefix: "",
        assetNotes: "",
      });
      toast.success("SKU and center stock added");
    } catch {
      toast.error("Failed to add SKU");
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdateSku = async () => {
    // Updates SKU metadata and optionally adds additional stock for this center.
    if (!selectedCenterId || !editingSkuId) return;
    const addQuantity = Math.max(0, Number(editSkuForm.addQuantity) || 0);
    setIsSaving(true);
    try {
      await apiFetch(`/api/v1/skus/${editingSkuId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editSkuForm.name,
          sku_code: editSkuForm.skuCode,
          category: editSkuForm.category || null,
          description: editSkuForm.description || null,
          image_url: editSkuForm.imageUrl || null,
          is_active: editSkuForm.isActive,
        }),
      });
      if (addQuantity > 0) {
        await createAssetsForCenter(editingSkuId, addQuantity, selectedCenterId, editSkuForm.skuCode, {
          status: editSkuForm.assetStatus,
          purchase_date: editSkuForm.purchaseDate || null,
          warranty_expiry: editSkuForm.warrantyExpiry || null,
          invoice_number: editSkuForm.invoiceNumber || null,
          invoice_url: editSkuForm.invoiceUrl || null,
          qr_code: editSkuForm.qrCodePrefix || null,
          notes: editSkuForm.assetNotes || null,
        });
      }
      await reloadInventory();
      setEditSkuDrawerOpen(false);
      toast.success("SKU updated");
    } catch {
      toast.error("Failed to update SKU");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {!selectedCenter && (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h1 className="text-2xl font-bold tracking-tight">Centers</h1>
            {can("centers.manage") && (
              <Button onClick={() => setDrawerOpen(true)}><Plus className="h-4 w-4 mr-2" /> Add New Center</Button>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {centers.map((center) => (
              <Card key={center.id} className="hover:shadow-md transition-shadow">
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-semibold text-foreground">{center.name}</h3>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                        <MapPin className="h-3 w-3" /> {center.city}, {center.state}
                      </div>
                    </div>
                    <Badge variant={center.isActive ? "default" : "secondary"}>{center.isActive ? "Active" : "Inactive"}</Badge>
                  </div>
                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <User className="h-3.5 w-3.5" /> {center.adminName}
                  </div>
                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Phone className="h-3.5 w-3.5" /> +91 {center.contactPhone}
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center border-t border-border pt-3">
                    <div><p className="text-lg font-bold text-foreground">{center.totalAssets}</p><p className="text-[10px] text-muted-foreground">Assets</p></div>
                    <div><p className="text-lg font-bold text-primary">{center.activeLeases}</p><p className="text-[10px] text-muted-foreground">Active Leases</p></div>
                    <div><p className="text-lg font-bold text-muted-foreground">{center.staff}</p><p className="text-[10px] text-muted-foreground">Staff</p></div>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2 pt-2 border-t border-border">
                    {can("centers.manage") && (
                      <Button variant="outline" size="sm" className="flex-1" onClick={() => openEditCenter(center)}>
                        <Pencil className="h-3.5 w-3.5 mr-1.5" /> Edit
                      </Button>
                    )}
                    <Button size="sm" className="flex-1" onClick={() => setSelectedCenterId(center.id)}>
                      <Package className="h-3.5 w-3.5 mr-1.5" /> Open Inventory
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}

      {selectedCenter && (
        <Card>
          <CardContent className="p-4 space-y-4">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setSelectedCenterId(null)}>
                  <ArrowLeft className="h-4 w-4 mr-1" /> Back
                </Button>
                <div>
                  <p className="font-semibold">{selectedCenter.name}</p>
                  <p className="text-xs text-muted-foreground">Center SKU stock and availability</p>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-2 w-full md:w-auto">
                <Button variant="outline" onClick={() => void reloadInventory()}>Refresh</Button>
                <Button onClick={() => setSkuDrawerOpen(true)}>
                  <Plus className="h-4 w-4 mr-1" /> Add SKU
                </Button>
              </div>
            </div>
            <div className="overflow-x-auto">
            <Table className="min-w-[920px]">
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Available</TableHead>
                  <TableHead>Leased</TableHead>
                  <TableHead>Under Repair</TableHead>
                  <TableHead>Borrowed Here</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {skuRows.map((row) => (
                  <TableRow key={row.sku.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{row.sku.name}</p>
                        <p className="text-xs text-muted-foreground font-mono">{row.sku.sku_code}</p>
                      </div>
                    </TableCell>
                    <TableCell>{row.counts.total}</TableCell>
                    <TableCell>{row.counts.available}</TableCell>
                    <TableCell>{row.counts.leased}</TableCell>
                    <TableCell>{row.counts.underRepair}</TableCell>
                    <TableCell>{row.counts.borrowedHere}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" onClick={() => openEditSku(row.sku.id)}>
                        <Pencil className="h-3.5 w-3.5 mr-1.5" /> Edit Stock
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {skuRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground py-6">
                      No SKU stock at this center yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            </div>
          </CardContent>
        </Card>
      )}

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader><SheetTitle>Add New Center</SheetTitle><SheetDescription>Register a new distribution center</SheetDescription></SheetHeader>
          <div className="space-y-4 mt-6">
            <div className="space-y-2"><Label>Center Name *</Label><Input placeholder="e.g. Nizamabad" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="space-y-2"><Label>Full Address</Label><Textarea placeholder="Full address..." value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2"><Label>City *</Label><Input placeholder="City" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></div>
              <div className="space-y-2"><Label>State</Label><Input placeholder="State" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} /></div>
            </div>
            <div className="space-y-2"><Label>PIN Code</Label><Input placeholder="e.g. 500001" value={form.pinCode} onChange={(e) => setForm({ ...form, pinCode: e.target.value })} /></div>
            <div className="space-y-2"><Label>Contact Person Name</Label><Input placeholder="Full name" value={form.contactPerson} onChange={(e) => setForm({ ...form, contactPerson: e.target.value })} /></div>
            <div className="space-y-2"><Label>Contact Phone</Label><Input placeholder="10-digit number" value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} /></div>
            <div className="flex items-center justify-between"><Label>Is Active</Label><Switch checked={form.isActive} onCheckedChange={(v) => setForm({ ...form, isActive: v })} /></div>
            <div className="flex flex-col md:flex-row gap-3 pt-4">
              <Button onClick={handleSave} className="flex-1 w-full md:w-auto" disabled={isSaving}>{isSaving ? "Saving..." : "Save Center"}</Button>
              <Button variant="outline" onClick={() => setDrawerOpen(false)} className="flex-1 w-full md:w-auto">Cancel</Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={editDrawerOpen} onOpenChange={setEditDrawerOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader><SheetTitle>Edit Center</SheetTitle><SheetDescription>Update distribution center details</SheetDescription></SheetHeader>
          <div className="space-y-4 mt-6">
            <div className="space-y-2"><Label>Center Name *</Label><Input placeholder="e.g. Nizamabad" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></div>
            <div className="space-y-2"><Label>Full Address</Label><Textarea placeholder="Full address..." value={editForm.address} onChange={(e) => setEditForm({ ...editForm, address: e.target.value })} /></div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2"><Label>City *</Label><Input placeholder="City" value={editForm.city} onChange={(e) => setEditForm({ ...editForm, city: e.target.value })} /></div>
              <div className="space-y-2"><Label>State</Label><Input placeholder="State" value={editForm.state} onChange={(e) => setEditForm({ ...editForm, state: e.target.value })} /></div>
            </div>
            <div className="space-y-2"><Label>PIN Code</Label><Input placeholder="e.g. 500001" value={editForm.pinCode} onChange={(e) => setEditForm({ ...editForm, pinCode: e.target.value })} /></div>
            <div className="space-y-2"><Label>Contact Person Name</Label><Input placeholder="Full name" value={editForm.contactPerson} onChange={(e) => setEditForm({ ...editForm, contactPerson: e.target.value })} /></div>
            <div className="space-y-2"><Label>Contact Phone</Label><Input placeholder="10-digit number" value={editForm.contactPhone} onChange={(e) => setEditForm({ ...editForm, contactPhone: e.target.value })} /></div>
            <div className="flex items-center justify-between"><Label>Is Active</Label><Switch checked={editForm.isActive} onCheckedChange={(v) => setEditForm({ ...editForm, isActive: v })} /></div>
            <div className="flex flex-col md:flex-row gap-3 pt-4">
              <Button onClick={handleUpdateCenter} className="flex-1 w-full md:w-auto" disabled={isSaving}>{isSaving ? "Saving..." : "Update Center"}</Button>
              <Button variant="outline" onClick={() => setEditDrawerOpen(false)} className="flex-1 w-full md:w-auto">Cancel</Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={skuDrawerOpen} onOpenChange={setSkuDrawerOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Add SKU + Stock</SheetTitle>
            <SheetDescription>Create SKU and add initial stock to this center.</SheetDescription>
          </SheetHeader>
          <div className="space-y-4 mt-6">
            <div className="space-y-2"><Label>SKU Name *</Label><Input value={skuForm.name} onChange={(e) => setSkuForm((p) => ({ ...p, name: e.target.value }))} /></div>
            <div className="space-y-2"><Label>SKU Code *</Label><Input value={skuForm.skuCode} onChange={(e) => setSkuForm((p) => ({ ...p, skuCode: e.target.value }))} /></div>
            <div className="space-y-2"><Label>Category</Label><Input value={skuForm.category} onChange={(e) => setSkuForm((p) => ({ ...p, category: e.target.value }))} /></div>
            <div className="space-y-2"><Label>Description</Label><Textarea value={skuForm.description} onChange={(e) => setSkuForm((p) => ({ ...p, description: e.target.value }))} /></div>
            <div className="space-y-2"><Label>Image URL</Label><Input value={skuForm.imageUrl} onChange={(e) => setSkuForm((p) => ({ ...p, imageUrl: e.target.value }))} /></div>
            <div className="space-y-2"><Label>Initial Quantity at Center *</Label><Input type="number" min={1} value={skuForm.initialQuantity} onChange={(e) => setSkuForm((p) => ({ ...p, initialQuantity: e.target.value }))} /></div>
            <div className="space-y-2">
              <Label>Default Asset Status</Label>
              <Select value={skuForm.assetStatus} onValueChange={(v) => setSkuForm((p) => ({ ...p, assetStatus: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="available">available</SelectItem>
                  <SelectItem value="leased">leased</SelectItem>
                  <SelectItem value="repair">repair</SelectItem>
                  <SelectItem value="retired">retired</SelectItem>
                  {/* <SelectItem value="in_transit">in_transit</SelectItem> */}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="space-y-2"><Label>Purchase Date</Label><Input type="date" value={skuForm.purchaseDate} onChange={(e) => setSkuForm((p) => ({ ...p, purchaseDate: e.target.value }))} /></div>
              <div className="space-y-2"><Label>Warranty Expiry</Label><Input type="date" value={skuForm.warrantyExpiry} onChange={(e) => setSkuForm((p) => ({ ...p, warrantyExpiry: e.target.value }))} /></div>
            </div>
            <div className="space-y-2"><Label>Invoice Number</Label><Input value={skuForm.invoiceNumber} onChange={(e) => setSkuForm((p) => ({ ...p, invoiceNumber: e.target.value }))} /></div>
            <div className="space-y-2"><Label>Invoice URL</Label><Input value={skuForm.invoiceUrl} onChange={(e) => setSkuForm((p) => ({ ...p, invoiceUrl: e.target.value }))} /></div>
            <div className="space-y-2"><Label>QR Code Prefix</Label><Input value={skuForm.qrCodePrefix} onChange={(e) => setSkuForm((p) => ({ ...p, qrCodePrefix: e.target.value }))} /></div>
            <div className="space-y-2"><Label>Asset Notes</Label><Textarea value={skuForm.assetNotes} onChange={(e) => setSkuForm((p) => ({ ...p, assetNotes: e.target.value }))} /></div>
            <div className="flex items-center justify-between"><Label>Active</Label><Switch checked={skuForm.isActive} onCheckedChange={(v) => setSkuForm((p) => ({ ...p, isActive: v }))} /></div>
            <div className="flex flex-col md:flex-row gap-3 pt-2">
              <Button onClick={handleSaveSku} className="flex-1 w-full md:w-auto" disabled={isSaving}>{isSaving ? "Saving..." : "Save"}</Button>
              <Button variant="outline" onClick={() => setSkuDrawerOpen(false)} className="flex-1 w-full md:w-auto">Cancel</Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={editSkuDrawerOpen} onOpenChange={setEditSkuDrawerOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Edit SKU / Add Stock</SheetTitle>
            <SheetDescription>Update SKU metadata and optionally add stock to selected center.</SheetDescription>
          </SheetHeader>
          <div className="space-y-4 mt-6">
            <div className="space-y-2"><Label>SKU Name *</Label><Input value={editSkuForm.name} onChange={(e) => setEditSkuForm((p) => ({ ...p, name: e.target.value }))} /></div>
            <div className="space-y-2"><Label>SKU Code *</Label><Input value={editSkuForm.skuCode} onChange={(e) => setEditSkuForm((p) => ({ ...p, skuCode: e.target.value }))} /></div>
            <div className="space-y-2"><Label>Category</Label><Input value={editSkuForm.category} onChange={(e) => setEditSkuForm((p) => ({ ...p, category: e.target.value }))} /></div>
            <div className="space-y-2"><Label>Description</Label><Textarea value={editSkuForm.description} onChange={(e) => setEditSkuForm((p) => ({ ...p, description: e.target.value }))} /></div>
            <div className="space-y-2"><Label>Image URL</Label><Input value={editSkuForm.imageUrl} onChange={(e) => setEditSkuForm((p) => ({ ...p, imageUrl: e.target.value }))} /></div>
            <div className="space-y-2"><Label>Add Quantity at This Center</Label><Input type="number" min={0} value={editSkuForm.addQuantity} onChange={(e) => setEditSkuForm((p) => ({ ...p, addQuantity: e.target.value }))} /></div>
            <div className="space-y-2">
              <Label>Default Status For Added Assets</Label>
              <Select value={editSkuForm.assetStatus} onValueChange={(v) => setEditSkuForm((p) => ({ ...p, assetStatus: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="available">available</SelectItem>
                  <SelectItem value="leased">leased</SelectItem>
                  <SelectItem value="repair">repair</SelectItem>
                  <SelectItem value="retired">retired</SelectItem>
                  {/* <SelectItem value="in_transit">in_transit</SelectItem> */}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="space-y-2"><Label>Purchase Date</Label><Input type="date" value={editSkuForm.purchaseDate} onChange={(e) => setEditSkuForm((p) => ({ ...p, purchaseDate: e.target.value }))} /></div>
              <div className="space-y-2"><Label>Warranty Expiry</Label><Input type="date" value={editSkuForm.warrantyExpiry} onChange={(e) => setEditSkuForm((p) => ({ ...p, warrantyExpiry: e.target.value }))} /></div>
            </div>
            <div className="space-y-2"><Label>Invoice Number</Label><Input value={editSkuForm.invoiceNumber} onChange={(e) => setEditSkuForm((p) => ({ ...p, invoiceNumber: e.target.value }))} /></div>
            <div className="space-y-2"><Label>Invoice URL</Label><Input value={editSkuForm.invoiceUrl} onChange={(e) => setEditSkuForm((p) => ({ ...p, invoiceUrl: e.target.value }))} /></div>
            <div className="space-y-2"><Label>QR Code Prefix</Label><Input value={editSkuForm.qrCodePrefix} onChange={(e) => setEditSkuForm((p) => ({ ...p, qrCodePrefix: e.target.value }))} /></div>
            <div className="space-y-2"><Label>Asset Notes</Label><Textarea value={editSkuForm.assetNotes} onChange={(e) => setEditSkuForm((p) => ({ ...p, assetNotes: e.target.value }))} /></div>
            <div className="flex items-center justify-between"><Label>Active</Label><Switch checked={editSkuForm.isActive} onCheckedChange={(v) => setEditSkuForm((p) => ({ ...p, isActive: v }))} /></div>
            <div className="flex flex-col md:flex-row gap-3 pt-2">
              <Button onClick={handleUpdateSku} className="flex-1 w-full md:w-auto" disabled={isSaving}>{isSaving ? "Saving..." : "Update"}</Button>
              <Button variant="outline" onClick={() => setEditSkuDrawerOpen(false)} className="flex-1 w-full md:w-auto">Cancel</Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
