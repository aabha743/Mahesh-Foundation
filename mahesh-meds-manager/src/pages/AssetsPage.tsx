import { useEffect, useMemo, useState } from "react";
import { PackageOpen, Pencil, Plus, QrCode, Search, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AssetCreateFlow } from "@/components/assets/AssetCreateFlow";
import { AssetEditSheet } from "@/components/assets/AssetEditSheet";
import { AssetQrDialog } from "@/components/assets/AssetQrDialog";
import { assetStatusOptions as statusOptions, type AssetView as Asset, type AssetStatus } from "@/lib/uiTypes";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";
import { dbAssetStatusToUi } from "@/lib/assetStatus";
import { useAuth } from "@/hooks/useAuth";

const statusColors: Record<AssetStatus, string> = {
  Available: "bg-success/10 text-success border-success/20",
  Leased: "bg-warning/10 text-warning border-warning/20",
  "Under Repair": "bg-destructive/10 text-destructive border-destructive/20",
  Retired: "bg-muted text-muted-foreground border-border",
};

export default function AssetsPage() {
  const { can } = useAuth();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [centerOptions, setCenterOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [search, setSearch] = useState("");
  const [filterCenter, setFilterCenter] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);

  useEffect(() => {
    async function loadData() {
      try {
        const [centers, skus, assetsResp] = await Promise.all([
          apiFetch<Array<{ id: string; name: string }>>("/api/v1/centers"),
          apiFetch<Array<{ id: string; name: string }>>("/api/v1/skus"),
          apiFetch<
            Array<{
              id: string;
              serial_number: string;
              status: string;
              purchase_date: string | null;
              warranty_expiry: string | null;
              notes: string | null;
              sku_id: string;
              center_id: string | null;
              home_center_id: string | null;
            }>
          >("/api/v1/assets"),
        ]);

        const skuMap = Object.fromEntries(skus.map((sku) => [sku.id, sku.name]));
        const centerMap = Object.fromEntries(centers.map((center) => [center.id, center.name]));

        setCenterOptions(centers);
        setAssets(
          assetsResp.map((asset) => ({
            id: asset.id,
            serialNumber: asset.serial_number,
            skuName: skuMap[asset.sku_id] ?? "Unknown SKU",
            assignedCenter: asset.center_id ? centerMap[asset.center_id] ?? "Unknown Center" : "Unassigned",
            homeCenter: asset.home_center_id
              ? centerMap[asset.home_center_id] ?? "Unknown Center"
              : asset.center_id
                ? centerMap[asset.center_id] ?? "Unknown Center"
                : "Unassigned",
            status: dbAssetStatusToUi(asset.status),
            purchaseDate: asset.purchase_date ?? "",
            warrantyExpiry: asset.warranty_expiry ?? "",
            notes: asset.notes ?? "",
          })),
        );
      } catch {
        toast.error("Could not load assets from API");
      }
    }

    void loadData();
  }, []);

  const filtered = useMemo(() => {
    return assets.filter((asset) => {
      const matchSearch =
        !search ||
        asset.serialNumber.toLowerCase().includes(search.toLowerCase()) ||
        asset.skuName.toLowerCase().includes(search.toLowerCase());
      const matchCenter = filterCenter === "all" || asset.assignedCenter === filterCenter;
      const matchStatus = filterStatus === "all" || asset.status === filterStatus;
      return matchSearch && matchCenter && matchStatus;
    });
  }, [assets, filterCenter, filterStatus, search]);

  async function handleDeleteAsset(asset: Asset) {
    if (!window.confirm(`Delete asset ${asset.serialNumber}?`)) return;
    try {
      await apiFetch(`/api/v1/assets/${asset.id}`, { method: "DELETE" });
      setAssets((current) => current.filter((item) => item.id !== asset.id));
      toast.success(`Deleted ${asset.serialNumber}`);
    } catch {
      toast.error("Failed to delete asset");
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col lg:flex-row gap-3 lg:items-center lg:justify-between">
        <div className="flex flex-col sm:flex-row gap-3 flex-1 w-full">
          <div className="relative flex-1 sm:max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search serial or SKU..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={filterCenter} onValueChange={setFilterCenter}>
            <SelectTrigger className="w-full sm:w-[180px]"><SelectValue placeholder="All Centers" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Centers</SelectItem>
              {centerOptions.map((center) => <SelectItem key={center.id} value={center.name}>{center.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-full sm:w-[160px]"><SelectValue placeholder="All Statuses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              {statusOptions.map((status) => <SelectItem key={status} value={status}>{status}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {can("assets.create") && (
          <Button onClick={() => setCreateOpen(true)} className="shrink-0">
            <Plus className="h-4 w-4 mr-2" />
            Add New Asset
          </Button>
        )}
      </div>

      <div className="flex items-center justify-between rounded-lg border bg-card px-4 py-3">
        <div>
          <p className="text-sm font-medium text-foreground">{filtered.length} asset{filtered.length === 1 ? "" : "s"} shown</p>
          <p className="text-xs text-muted-foreground">
            {search || filterCenter !== "all" || filterStatus !== "all"
              ? "Filtered results based on your current search and selections"
              : "All assets across centers"}
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="hidden md:block overflow-x-auto">
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead>Serial Number</TableHead>
                <TableHead>SKU Name</TableHead>
                <TableHead className="hidden md:table-cell">Current Location</TableHead>
                <TableHead className="hidden lg:table-cell">Home Center</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden xl:table-cell">Warranty Expiry</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((asset) => (
                <TableRow key={asset.id}>
                  <TableCell className="font-mono text-sm">{asset.serialNumber}</TableCell>
                  <TableCell className="font-medium">{asset.skuName}</TableCell>
                  <TableCell className="hidden md:table-cell text-muted-foreground">{asset.assignedCenter}</TableCell>
                  <TableCell className="hidden lg:table-cell text-muted-foreground">{asset.homeCenter}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn("border", statusColors[asset.status])}>
                      {asset.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden xl:table-cell text-muted-foreground">{asset.warrantyExpiry || "—"}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {can("assets.update") && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title="Edit asset"
                          onClick={() => {
                            setSelectedAsset(asset);
                            setEditOpen(true);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="View QR"
                        onClick={() => {
                          setSelectedAsset(asset);
                          setQrOpen(true);
                        }}
                      >
                        <QrCode className="h-3.5 w-3.5" />
                      </Button>
                      {can("assets.update") && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          title="Delete asset"
                          onClick={() => void handleDeleteAsset(asset)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-14">
                    <div className="flex flex-col items-center justify-center text-center space-y-3">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                        <PackageOpen className="h-6 w-6 text-muted-foreground" />
                      </div>
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-foreground">No assets found</p>
                        <p className="text-sm text-muted-foreground">
                          {search || filterCenter !== "all" || filterStatus !== "all"
                            ? "Try changing your filters or search terms."
                            : "Start by adding your first asset to the system."}
                        </p>
                      </div>
                      {can("assets.create") && !search && filterCenter === "all" && filterStatus === "all" && (
                        <Button onClick={() => setCreateOpen(true)} size="sm">
                          <Plus className="h-4 w-4 mr-2" />
                          Add First Asset
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          </div>

          <div className="md:hidden space-y-3 p-4">
            {filtered.map((asset) => (
              <div key={asset.id} className="rounded-lg border bg-card p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-base font-bold break-all">{asset.serialNumber}</p>
                    <p className="text-sm text-muted-foreground">{asset.skuName}</p>
                  </div>
                  <Badge variant="outline" className={cn("border", statusColors[asset.status])}>
                    {asset.status}
                  </Badge>
                </div>
                <div className="text-sm text-muted-foreground space-y-1">
                  <p>Center: <span className="text-foreground">{asset.assignedCenter}</span></p>
                  <p>Home: <span className="text-foreground">{asset.homeCenter}</span></p>
                </div>
                <div className="flex flex-col gap-2">
                  {can("assets.update") && (
                    <Button
                      variant="outline"
                      className="w-full justify-start"
                      onClick={() => {
                        setSelectedAsset(asset);
                        setEditOpen(true);
                      }}
                    >
                      <Pencil className="h-4 w-4 mr-2" />
                      Edit asset
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    onClick={() => {
                      setSelectedAsset(asset);
                      setQrOpen(true);
                    }}
                  >
                    <QrCode className="h-4 w-4 mr-2" />
                    View QR
                  </Button>
                  {can("assets.update") && (
                    <Button
                      variant="outline"
                      className="w-full justify-start text-destructive hover:text-destructive"
                      onClick={() => void handleDeleteAsset(asset)}
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete asset
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">No assets found</div>
            )}
          </div>
        </CardContent>
      </Card>

      <AssetCreateFlow
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(asset) => setAssets((current) => [asset, ...current])}
      />

      <AssetEditSheet
        asset={selectedAsset}
        centerOptions={centerOptions}
        open={editOpen}
        onOpenChange={setEditOpen}
        onUpdated={(updatedAsset) =>
          setAssets((current) => current.map((asset) => (asset.id === updatedAsset.id ? updatedAsset : asset)))
        }
      />

      <AssetQrDialog asset={selectedAsset} open={qrOpen} onOpenChange={setQrOpen} />
    </div>
  );
}
