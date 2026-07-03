import { useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Package, CheckCircle, ArrowRightLeft, Wrench, Send, CornerDownLeft, AlertTriangle, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import { useCenterScope } from "@/hooks/useCenterScope";
import { apiFetch, listCenterActivity, type CenterActivityLog } from "@/lib/api";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { type AssetForLocalStock } from "@/lib/leaseLocalAvailability";
import { Skeleton } from "@/components/ui/skeleton";

const iconMap = { Package, CheckCircle, ArrowRightLeft, Wrench };
const colorMap = {
  primary: "border-l-4 border-l-primary",
  success: "border-l-4 border-l-success",
  info: "border-l-4 border-l-info",
  warning: "border-l-4 border-l-warning",
};
const iconColorMap = {
  primary: "text-primary",
  success: "text-success",
  info: "text-info",
  warning: "text-warning",
};

type AssetApi = AssetForLocalStock & {
  id: string;
  warranty_expiry: string | null;
  home_center_id?: string | null;
};

type LeaseRequestApi = {
  id: string;
  token_number: string;
  status: string;
  created_at: string;
  skus: string[];
  fulfillment_centers?: Array<{ center_id: string; center_name: string }>;
  items?: Array<{ sku_id: string; quantity_requested: number; asset_id: string | null }>;
};

type UserApi = {
  id: string;
  name: string;
  mobile: string;
  roles: string[];
  center_id: string | null;
  is_active: boolean;
};

function formatActivityAction(action: string) {
  const known: Record<string, string> = {
    asset_created: "Asset added",
    asset_updated: "Asset updated",
    token_viewed: "Token looked up",
    devices_issued: "Device issued",
  };
  if (known[action]) return known[action];
  return action
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isLeaseRelevantToCenter(
  request: LeaseRequestApi,
  centerId: string,
  assets: AssetApi[],
): boolean {
  if ((request.fulfillment_centers ?? []).some((center) => center.center_id === centerId)) {
    return true;
  }

  const assetsById = Object.fromEntries(assets.map((asset) => [asset.id, asset]));

  return (request.items ?? []).some((item) => {
    if (item.asset_id) {
      const asset = assetsById[item.asset_id];
      const leaseCenterId = asset?.home_center_id ?? asset?.center_id;
      return leaseCenterId === centerId;
    }
    return false;
  });
}

export default function CenterDashboard() {
  const navigate = useNavigate();
  const { centerId, loading: centerLoading } = useCenterScope();
  const [assets, setAssets] = useState<AssetApi[]>([]);
  const [leaseRequests, setLeaseRequests] = useState<LeaseRequestApi[]>([]);
  const [users, setUsers] = useState<UserApi[]>([]);
  const [recentActivity, setRecentActivity] = useState<CenterActivityLog[]>([]);
  const [recentActivityLoading, setRecentActivityLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const { hasRole, can } = useAuth();

  useEffect(() => {
    if (!centerId) return;
    let cancelled = false;

    async function load() {
      try {
        const [assetList, leaseList, userList] = await Promise.all([
          apiFetch<AssetApi[]>("/api/v1/assets"),
          apiFetch<LeaseRequestApi[]>("/api/v1/lease-requests"),
          can("users.manage") ? apiFetch<UserApi[]>("/api/v1/users") : Promise.resolve([] as UserApi[]),
        ]);
        if (cancelled) return;

        setAssets(assetList.filter((asset) => asset.center_id === centerId));
        setLeaseRequests(leaseList.filter((request) => isLeaseRelevantToCenter(request, centerId, assetList)));
        setUsers(userList);
        setLoadError(false);
      } catch {
        if (!cancelled) {
          setLoadError(true);
          toast.error("Could not load center assets");
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [centerId, can]);

  useEffect(() => {
    if (!centerId) return;
    let cancelled = false;

    async function loadRecentActivity() {
      try {
        if (!cancelled) setRecentActivityLoading(true);
        const logs = await listCenterActivity(10, "centers");
        if (cancelled) return;
        setRecentActivity(logs.filter((log) => log.center_id === centerId));
      } catch {
        if (!cancelled) {
          setRecentActivity([]);
        }
      } finally {
        if (!cancelled) setRecentActivityLoading(false);
      }
    }

    void loadRecentActivity();
    const intervalId = window.setInterval(() => {
      void loadRecentActivity();
    }, 60000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [centerId]);

  const approvedAwaitingIssue = useMemo(
    () => leaseRequests.filter((request) => request.status === "approved").slice(0, 5),
    [leaseRequests],
  );

  const activeLeaseCount = useMemo(
    () => leaseRequests.filter((request) => request.status === "active").length,
    [leaseRequests],
  );

  const localStockShortageCount = useMemo(
    () =>
      leaseRequests.filter((request) => {
        if (request.status !== "approved") return false;
        return (request.items ?? []).every((item) => {
          if (item.asset_id) return false;
          return !assets.some((asset) => asset.sku_id === item.sku_id && asset.status === "available");
        });
      }).length,
    [leaseRequests, assets],
  );

  const isCenterManager = hasRole("center_manager");
  const centerAssetManagers = useMemo(
    () =>
      users.filter(
        (user) => user.roles.includes("asset_manager") && user.is_active && user.center_id === centerId,
      ),
    [users, centerId],
  );

  const summary = useMemo(() => {
    const total = assets.length;
    const available = assets.filter((asset) => asset.status === "available").length;
    const leased = assets.filter((asset) => asset.status === "leased").length;
    const repair = assets.filter((asset) => asset.status === "under_repair").length;
    return [
      { title: "Total Assets", value: total, subtitle: "All registered devices", color: "primary" as const, icon: "Package" as const },
      { title: "Available", value: available, subtitle: "Ready to issue", color: "success" as const, icon: "CheckCircle" as const },
      { title: "Leased", value: leased, subtitle: "Currently issued", color: "info" as const, icon: "ArrowRightLeft" as const },
      { title: "Under Repair", value: repair, subtitle: "In maintenance", color: "warning" as const, icon: "Wrench" as const },
    ];
  }, [assets]);

  const warrantyAlerts = useMemo(() => {
    const now = new Date();
    const soon = new Date(now);
    soon.setDate(soon.getDate() + 30);
    return assets
      .filter((asset) => asset.warranty_expiry)
      .map((asset) => ({ id: asset.id, date: asset.warranty_expiry! }))
      .filter(({ date }) => {
        const parsed = new Date(date);
        return !Number.isNaN(parsed.getTime()) && parsed >= now && parsed <= soon;
      })
      .slice(0, 5)
      .map(({ date }) => ({
        message: `Warranty expires on ${date}`,
        date,
      }));
  }, [assets]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        {summary.map((card) => {
          const Icon = iconMap[card.icon];
          return (
            <Card key={card.title} className={colorMap[card.color]}>
              <CardContent className="p-4 xl:p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">{card.title}</p>
                    <p className="text-2xl font-bold text-foreground mt-1">{centerLoading ? "-" : card.value}</p>
                    <p className="text-xs text-muted-foreground mt-1">{card.subtitle}</p>
                  </div>
                  <Icon className={`h-7 w-7 xl:h-8 xl:w-8 ${iconColorMap[card.color]}`} />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Button size="lg" className="h-14 xl:h-16 text-sm xl:text-base gap-2 bg-success hover:bg-success/90 text-success-foreground" onClick={() => navigate("/center/issue")}>
          <Send className="h-5 w-5" /> Issue Device
        </Button>
        <Button size="lg" className="h-14 xl:h-16 text-sm xl:text-base gap-2 bg-info hover:bg-info/90 text-info-foreground" onClick={() => navigate("/center/return")}>
          <CornerDownLeft className="h-5 w-5" /> Return Device
        </Button>
      </div>

      <Card className="border-info/40 bg-info/5">
        <CardContent className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">
              Approved requests waiting on this center: {approvedAwaitingIssue.length}
            </p>
            <p className="text-xs text-muted-foreground">
              Active leases tied to this center: {activeLeaseCount}
            </p>
            {localStockShortageCount > 0 && (
              <p className="text-xs text-warning mt-2 font-medium">
                {localStockShortageCount} approved request(s) still need stock at this center before issue can happen here.
              </p>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={() => navigate("/center/lease-requests")}>
            Open Lease Tracking
          </Button>
        </CardContent>
      </Card>

      {isCenterManager && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Asset Managers ({centerAssetManagers.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {centerAssetManagers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No asset managers assigned to this center yet.</p>
            ) : (
              centerAssetManagers.map((manager) => (
                <div key={manager.id} className="p-3 rounded-lg border bg-muted/30">
                  <p className="text-sm font-medium text-foreground">{manager.name}</p>
                  <p className="text-xs text-muted-foreground">Mobile: {manager.mobile}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {recentActivityLoading ? (
              <div className="space-y-3 py-2">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="space-y-2">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-28" />
                  </div>
                ))}
              </div>
            ) : recentActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6">No recent activity</p>
            ) : (
              <div className="space-y-4">
                {recentActivity.map((log) => (
                  <div key={log.id} className="flex gap-3">
                    <div className="mt-1 h-2.5 w-2.5 rounded-full bg-primary shrink-0" />
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm font-medium text-foreground">{formatActivityAction(log.action)}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(log.created_at), { addSuffix: true })}
                        {log.user_name ? ` · ${log.user_name}` : ""}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Alerts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {loadError && (
              <div className="p-3 rounded-lg border bg-destructive/10 border-destructive/30 text-sm">Failed to load asset data.</div>
            )}
            {!loadError && warrantyAlerts.length === 0 && (
              <p className="text-sm text-muted-foreground">No upcoming warranty expiries in the next 30 days.</p>
            )}
            {warrantyAlerts.map((alert, index) => (
              <div key={index} className="p-3 rounded-lg border bg-warning/10 border-warning/30">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm text-foreground">{alert.message}</p>
                    <p className="text-xs text-muted-foreground mt-1">{alert.date}</p>
                  </div>
                </div>
              </div>
            ))}
            {!loadError && approvedAwaitingIssue.length > 0 && (
              <div className="p-3 rounded-lg border bg-info/10 border-info/30">
                <div className="flex items-start gap-2">
                  <Clock className="h-4 w-4 text-info shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm text-foreground">
                      {approvedAwaitingIssue.length} approved request(s) can be worked on from this center.
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Latest token: {approvedAwaitingIssue[0]?.token_number}
                    </p>
                  </div>
                </div>
              </div>
            )}
            {!loadError && (
              <div className="p-3 rounded-lg border bg-muted/40 border-border">
                <div className="flex items-start gap-2">
                  <Clock className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                  <p className="text-sm text-muted-foreground">
                    Assets must now be issued and returned at their own center. Cross-center transfer workflow is disabled.
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
