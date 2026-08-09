import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type LeaseStatus } from "@/lib/uiTypes";
import { formatLeaseStatus } from "@/lib/utils";
import { useCenterScope } from "@/hooks/useCenterScope";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";
import { type AssetForLocalStock } from "@/lib/leaseLocalAvailability";

const statusColors: Record<string, string> = {
  Pending: "bg-warning/15 text-warning border-warning/30",
  Approved: "bg-success/15 text-success border-success/30",
  Rejected: "bg-destructive/15 text-destructive border-destructive/30",
  Active: "bg-info/15 text-info border-info/30",
  Closed: "bg-muted text-muted-foreground border-border",
};

type RequestApi = {
  id: string;
  token_number: string;
  requestor_name: string;
  patient_name?: string | null;
  mobile: string;
  status: string;
  created_at: string;
  skus: string[];
  fulfillment_centers?: Array<{ center_id: string; center_name: string }>;
  items?: Array<{ sku_id: string; quantity_requested: number; asset_id: string | null }>;
};

type CenterAssetApi = AssetForLocalStock & {
  id: string;
  home_center_id?: string | null;
};

type Row = {
  id: string;
  token: string;
  requestorName: string;
  patientName?: string | null;
  mobile: string;
  skus: string[];
  status: LeaseStatus;
  submittedDate: string;
  localStatus: "Ready here" | "Issued here" | "Other center";
};

function resolveLocalStatus(
  request: RequestApi,
  centerId: string,
  assets: CenterAssetApi[],
): Row["localStatus"] | null {
  if ((request.fulfillment_centers ?? []).some((center) => center.center_id === centerId)) {
    return "Ready here";
  }

  const assetsById = Object.fromEntries(assets.map((asset) => [asset.id, asset]));

  let hasIssuedHere = false;
  for (const item of request.items ?? []) {
    if (item.asset_id) {
      const asset = assetsById[item.asset_id];
      const leaseCenterId = asset?.home_center_id ?? asset?.center_id;
      if (leaseCenterId === centerId) {
        hasIssuedHere = true;
      }
    }
  }

  if (hasIssuedHere) return "Issued here";
  return null;
}

export default function CenterLeaseRequests() {
  const { centerId } = useCenterScope();
  const [tab, setTab] = useState("All");
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    if (!centerId) return;
    let cancelled = false;

    async function load() {
      try {
        const [requests, assets] = await Promise.all([
          apiFetch<RequestApi[]>("/api/v1/lease-requests"),
          apiFetch<CenterAssetApi[]>("/api/v1/assets"),
        ]);
        if (cancelled) return;

        const nextRows = requests
          .map((request) => {
            const localStatus = resolveLocalStatus(request, centerId, assets);
            if (!localStatus) return null;
            return {
              id: request.id,
              token: request.token_number,
              requestorName: request.requestor_name,
              patientName: request.patient_name,
              mobile: request.mobile,
              skus: request.skus ?? [],
              status: formatLeaseStatus(request.status) as LeaseStatus,
              submittedDate: request.created_at.slice(0, 10),
              localStatus,
            } satisfies Row;
          })
          .filter((row): row is Row => row !== null);

        setRows(nextRows);
      } catch {
        toast.error("Could not load lease requests");
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [centerId]);

  const filtered = useMemo(() => {
    if (tab === "All") return rows;
    if (tab === "Active Leases") return rows.filter((row) => row.status === "Active");
    return rows.filter((row) => row.status === tab);
  }, [rows, tab]);

  const counts = useMemo(
    () => ({
      all: rows.length,
      pending: rows.filter((row) => row.status === "Pending").length,
      approved: rows.filter((row) => row.status === "Approved").length,
      active: rows.filter((row) => row.status === "Active").length,
      closed: rows.filter((row) => row.status === "Closed").length,
    }),
    [rows],
  );

  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="All">All ({counts.all})</TabsTrigger>
          <TabsTrigger value="Pending">Pending ({counts.pending})</TabsTrigger>
          <TabsTrigger value="Approved">Approved ({counts.approved})</TabsTrigger>
          <TabsTrigger value="Active Leases">Active Leases ({counts.active})</TabsTrigger>
          <TabsTrigger value="Closed">Closed ({counts.closed})</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="border rounded-lg overflow-auto">
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow>
              <TableHead>Token</TableHead>
              <TableHead>Requestor</TableHead>
              <TableHead>Mobile</TableHead>
              <TableHead>SKUs</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Center Match</TableHead>
              <TableHead>Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-mono text-primary text-sm">{row.token}</TableCell>
                <TableCell>
                  <div>{row.requestorName}</div>
                  {row.patientName && row.patientName !== row.requestorName && (
                    <div className="text-xs text-muted-foreground">Patient: {row.patientName}</div>
                  )}
                </TableCell>
                <TableCell className="text-sm">{row.mobile}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {row.skus.length > 0 ? (
                      row.skus.map((sku, index) => (
                        <Badge key={`${row.id}-${index}-${sku}`} variant="secondary" className="text-xs">
                          {sku}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-xs text-muted-foreground">No items</span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={statusColors[row.status]}>
                    {row.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs">
                  <Badge
                    variant="outline"
                    className={
                      row.localStatus === "Ready here"
                        ? "border-success/40 bg-success/15 text-success"
                        : row.localStatus === "Issued here"
                          ? "border-info/40 bg-info/15 text-info"
                          : "border-border bg-muted text-muted-foreground"
                    }
                  >
                    {row.localStatus}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm">{row.submittedDate}</TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                  No requests found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
