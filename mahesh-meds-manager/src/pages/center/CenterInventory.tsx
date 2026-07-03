import { useEffect, useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { Search, AlertTriangle, Phone } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AssetStatus } from "@/lib/uiTypes";
import { useCenterScope } from "@/hooks/useCenterScope";
import { apiFetch } from "@/lib/api";
import { dbAssetStatusToUi } from "@/lib/assetStatus";
import { toast } from "sonner";

const statusColors: Record<AssetStatus, string> = {
  Available: "bg-success/15 text-success border-success/30",
  Leased: "bg-warning/15 text-warning border-warning/30",
  "Under Repair": "bg-destructive/15 text-destructive border-destructive/30",
  Retired: "bg-muted text-muted-foreground border-border",
};

type AssetApi = {
  id: string;
  serial_number: string;
  sku_id: string;
  center_id: string | null;
  home_center_id?: string | null;
  status: string;
  warranty_expiry: string | null;
};

type LeaseRequestApi = {
  id: string;
  token_number: string;
  requestor_name: string;
  mobile: string;
  status: string;
  items?: Array<{
    sku_id: string;
    sku_name: string;
    quantity_requested: number;
    asset_id: string | null;
    due_date: string | null;
  }>;
};

type Row = {
  id: string;
  serialNumber: string;
  skuName: string;
  status: AssetStatus;
  position: string;
  warrantyExpiry: string;
  lesseeName: string | null;
  lesseeMobile: string | null;
  dueDate: string | null;
  dueState: "none" | "upcoming" | "overdue";
  dueLabel: string;
  tokenNumber: string | null;
};

function daysUntil(date: string): number | null {
  try {
    const target = parseISO(date);
    const now = new Date();
    const targetStart = new Date(target.getFullYear(), target.getMonth(), target.getDate());
    const nowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((targetStart.getTime() - nowStart.getTime()) / (1000 * 60 * 60 * 24));
  } catch {
    return null;
  }
}

function dueBadge(dueDate: string | null): { state: Row["dueState"]; label: string } {
  if (!dueDate) return { state: "none", label: "—" };
  const delta = daysUntil(dueDate);
  if (delta === null) return { state: "none", label: dueDate };
  if (delta < 0) return { state: "overdue", label: `${Math.abs(delta)} day(s) overdue` };
  if (delta <= 7) return { state: "upcoming", label: `Due in ${delta} day(s)` };
  return { state: "none", label: format(parseISO(dueDate), "dd MMM yyyy") };
}

export default function CenterInventory() {
  const { centerId } = useCenterScope();
  const [rows, setRows] = useState<Row[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [dueFilter, setDueFilter] = useState("all");

  useEffect(() => {
    if (!centerId) return;
    let cancelled = false;

    async function load() {
      try {
        const [skus, assets, leases] = await Promise.all([
          apiFetch<Array<{ id: string; name: string }>>("/api/v1/skus"),
          apiFetch<AssetApi[]>("/api/v1/assets"),
          apiFetch<LeaseRequestApi[]>("/api/v1/lease-requests"),
        ]);
        if (cancelled) return;

        const skuMap = Object.fromEntries(skus.map((sku) => [sku.id, sku.name]));
        const activeAssignments = new Map<
          string,
          { requestorName: string; mobile: string; dueDate: string | null; tokenNumber: string }
        >();

        for (const lease of leases) {
          if (!lease.items?.length) continue;
          for (const item of lease.items) {
            if (!item.asset_id) continue;
            activeAssignments.set(item.asset_id, {
              requestorName: lease.requestor_name,
              mobile: lease.mobile,
              dueDate: item.due_date,
              tokenNumber: lease.token_number,
            });
          }
        }

        const mine = assets.filter((asset) => (asset.home_center_id ?? asset.center_id) === centerId);
        setRows(
          mine.map((asset) => {
            const assignment = activeAssignments.get(asset.id);
            const status = dbAssetStatusToUi(asset.status);
            const due = dueBadge(assignment?.dueDate ?? null);
            const position =
              status === "Available"
                ? "At center"
                : status === "Leased"
                  ? "With lessee"
                  : status === "Under Repair"
                    ? "Sent for repair"
                    : "Retired";

            return {
              id: asset.id,
              serialNumber: asset.serial_number,
              skuName: skuMap[asset.sku_id] ?? "Unknown SKU",
              status,
              position,
              warrantyExpiry: asset.warranty_expiry ? format(parseISO(asset.warranty_expiry), "dd MMM yyyy") : "—",
              lesseeName: assignment?.requestorName ?? null,
              lesseeMobile: assignment?.mobile ?? null,
              dueDate: assignment?.dueDate ?? null,
              dueState: due.state,
              dueLabel: due.label,
              tokenNumber: assignment?.tokenNumber ?? null,
            } satisfies Row;
          }),
        );
      } catch {
        toast.error("Could not load center assets");
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [centerId]);

  const filtered = useMemo(() => {
    return rows.filter((asset) => {
      const matchesSearch =
        !search ||
        asset.serialNumber.toLowerCase().includes(search.toLowerCase()) ||
        asset.skuName.toLowerCase().includes(search.toLowerCase()) ||
        (asset.lesseeName ?? "").toLowerCase().includes(search.toLowerCase()) ||
        (asset.lesseeMobile ?? "").includes(search);
      const matchesStatus = statusFilter === "all" || asset.status === statusFilter;
      const matchesDue =
        dueFilter === "all" ||
        (dueFilter === "overdue" && asset.dueState === "overdue") ||
        (dueFilter === "upcoming" && asset.dueState === "upcoming");
      return matchesSearch && matchesStatus && matchesDue;
    });
  }, [rows, search, statusFilter, dueFilter]);

  const followUpCount = useMemo(
    () => rows.filter((asset) => asset.dueState === "overdue" || asset.dueState === "upcoming").length,
    [rows],
  );

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card px-4 py-3">
        <p className="text-sm font-medium text-foreground">Center asset tracker</p>
        <p className="text-xs text-muted-foreground mt-1">
          {followUpCount} asset(s) need return follow-up soon or are already overdue.
        </p>
      </div>

      <div className="flex flex-col lg:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search serial, SKU, lessee, or mobile..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full lg:w-[180px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="Available">Available</SelectItem>
            <SelectItem value="Leased">Leased</SelectItem>
            <SelectItem value="Under Repair">Under Repair</SelectItem>
            <SelectItem value="Retired">Retired</SelectItem>
          </SelectContent>
        </Select>
        <Select value={dueFilter} onValueChange={setDueFilter}>
          <SelectTrigger className="w-full lg:w-[180px]">
            <SelectValue placeholder="Due filter" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Due Dates</SelectItem>
            <SelectItem value="upcoming">Due Within 7 Days</SelectItem>
            <SelectItem value="overdue">Overdue</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="border rounded-lg overflow-auto">
        <Table className="min-w-[1100px]">
          <TableHeader>
            <TableRow>
              <TableHead>Serial Number</TableHead>
              <TableHead>SKU Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Position</TableHead>
              <TableHead>Lessee</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Due Back</TableHead>
              <TableHead>Token</TableHead>
              <TableHead>Warranty Expiry</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((asset) => (
              <TableRow key={asset.id}>
                <TableCell className="font-mono text-sm">{asset.serialNumber}</TableCell>
                <TableCell>{asset.skuName}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={statusColors[asset.status]}>
                    {asset.status}
                  </Badge>
                </TableCell>
                <TableCell>{asset.position}</TableCell>
                <TableCell>
                  {asset.lesseeName ? (
                    <div className="space-y-1">
                      <p className="text-sm font-medium">{asset.lesseeName}</p>
                      {asset.dueState !== "none" && (
                        <p className="text-xs text-muted-foreground">Follow up on return</p>
                      )}
                    </div>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell>
                  {asset.lesseeMobile ? (
                    <div className="flex items-center gap-2 text-sm">
                      <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                      <span>{asset.lesseeMobile}</span>
                    </div>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell>
                  {asset.dueDate ? (
                    <div className="space-y-1">
                      <p className="text-sm">{format(parseISO(asset.dueDate), "dd MMM yyyy")}</p>
                      <Badge
                        variant="outline"
                        className={
                          asset.dueState === "overdue"
                            ? "border-destructive/40 bg-destructive/10 text-destructive"
                            : asset.dueState === "upcoming"
                              ? "border-warning/40 bg-warning/10 text-warning"
                              : "border-border bg-muted text-muted-foreground"
                        }
                      >
                        {asset.dueState !== "none" && <AlertTriangle className="mr-1 h-3 w-3" />}
                        {asset.dueLabel}
                      </Badge>
                    </div>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">{asset.tokenNumber ?? "—"}</TableCell>
                <TableCell>{asset.warrantyExpiry}</TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                  No assets found for the selected filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
