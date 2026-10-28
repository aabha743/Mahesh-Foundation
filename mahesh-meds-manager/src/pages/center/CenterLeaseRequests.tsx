import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type LeaseStatus } from "@/lib/uiTypes";
import { formatLeaseStatus } from "@/lib/utils";
import { useCenterScope } from "@/hooks/useCenterScope";
import { useLeaseRequestCounts, useLeaseRequestPages } from "@/hooks/useLeaseRequestPages";
import { apiFetch, type LeaseRequestStatus } from "@/lib/api";
import { toast } from "sonner";
import { type AssetForLocalStock } from "@/lib/leaseLocalAvailability";
import { ShowMoreButton } from "@/components/ShowMoreButton";

const statusColors: Record<string, string> = {
  Pending: "bg-warning/15 text-warning border-warning/30",
  Approved: "bg-success/15 text-success border-success/30",
  Rejected: "bg-destructive/15 text-destructive border-destructive/30",
  Active: "bg-info/15 text-info border-info/30",
  Closed: "bg-muted text-muted-foreground border-border",
  Expired: "bg-warning/15 text-warning border-warning/30",
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
  /** Null when neither rule matches here; the server still lists the request for this center. */
  localStatus: "Ready here" | "Issued here" | null;
};

type Tab = "All" | "Pending" | "Approved" | "Active Leases" | "Closed";

/** The status each tab asks the server for; All lists every status. */
const tabStatus: Record<Tab, LeaseRequestStatus | undefined> = {
  All: undefined,
  Pending: "pending",
  Approved: "approved",
  "Active Leases": "active",
  Closed: "closed",
};

function resolveLocalStatus(
  request: RequestApi,
  centerId: string,
  assetsById: Record<string, CenterAssetApi>,
): Row["localStatus"] {
  if ((request.fulfillment_centers ?? []).some((center) => center.center_id === centerId)) {
    return "Ready here";
  }

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
  const [tab, setTab] = useState<Tab>("All");
  const [assets, setAssets] = useState<CenterAssetApi[]>([]);

  // The server keeps to the requests this center works on; each tab asks for its own status.
  const { rows: requests, hasMore, loading, loadingMore, loadMore } = useLeaseRequestPages<RequestApi>(
    centerId ? { centerId, status: tabStatus[tab] } : null,
    "Could not load lease requests",
  );
  const { counts } = useLeaseRequestCounts(centerId, Boolean(centerId));

  useEffect(() => {
    if (!centerId) return;
    let cancelled = false;

    // Assets give the "Issued here" label for requests whose devices belong to this center.
    async function loadAssets() {
      try {
        const assetList = await apiFetch<CenterAssetApi[]>("/api/v1/assets");
        if (!cancelled) setAssets(assetList);
      } catch {
        if (!cancelled) toast.error("Could not load lease requests");
      }
    }

    void loadAssets();
    return () => {
      cancelled = true;
    };
  }, [centerId]);

  const rows = useMemo(() => {
    if (!centerId) return [];
    const assetsById = Object.fromEntries(assets.map((asset) => [asset.id, asset]));
    return requests.map(
      (request): Row => ({
        id: request.id,
        token: request.token_number,
        requestorName: request.requestor_name,
        patientName: request.patient_name,
        mobile: request.mobile,
        skus: request.skus ?? [],
        status: formatLeaseStatus(request.status) as LeaseStatus,
        submittedDate: request.created_at.slice(0, 10),
        localStatus: resolveLocalStatus(request, centerId, assetsById),
      }),
    );
  }, [requests, assets, centerId]);

  const tabCount = (value: Tab) => {
    if (!counts) return 0;
    const status = tabStatus[value];
    return status ? counts.by_status[status] ?? 0 : counts.total;
  };

  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="All">All ({tabCount("All")})</TabsTrigger>
          <TabsTrigger value="Pending">Pending ({tabCount("Pending")})</TabsTrigger>
          <TabsTrigger value="Approved">Approved ({tabCount("Approved")})</TabsTrigger>
          <TabsTrigger value="Active Leases">Active Leases ({tabCount("Active Leases")})</TabsTrigger>
          <TabsTrigger value="Closed">Closed ({tabCount("Closed")})</TabsTrigger>
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
            {rows.map((row) => (
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
                  {row.localStatus ? (
                    <Badge
                      variant="outline"
                      className={
                        row.localStatus === "Ready here"
                          ? "border-success/40 bg-success/15 text-success"
                          : "border-info/40 bg-info/15 text-info"
                      }
                    >
                      {row.localStatus}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-sm">{row.submittedDate}</TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                  {loading ? "Loading requests..." : "No requests found"}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <ShowMoreButton hasMore={hasMore} loading={loadingMore} onClick={() => void loadMore()} />
    </div>
  );
}
