import { useEffect, useMemo, useState } from "react";
import { Package, CheckCircle, ArrowRightLeft, Wrench, AlertTriangle, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch } from "@/lib/api";

const iconMap = {
  Package, CheckCircle, ArrowRightLeft, Wrench,
};

const colorMap = {
  primary: { border: "border-l-primary", bg: "bg-primary/10", text: "text-primary" },
  success: { border: "border-l-success", bg: "bg-success/10", text: "text-success" },
  info: { border: "border-l-info", bg: "bg-info/10", text: "text-info" },
  warning: { border: "border-l-warning", bg: "bg-warning/10", text: "text-warning" },
};

const statusVariant: Record<string, "default" | "secondary" | "destructive"> = {
  Pending: "secondary",
  Approved: "default",
  Rejected: "destructive",
  Active: "secondary",
  Closed: "secondary",
};

type LeaseRow = { token: string; name: string; skus: string; status: "Pending" | "Approved" | "Rejected" | "Active" | "Closed"; date: string };
type AlertRow = { type: "warranty" | "overdue"; message: string; date: string };

export default function Dashboard() {
  // Renders admin dashboard using live API-backed metrics and alerts.
  const [summaryCards, setSummaryCards] = useState<
    Array<{ title: string; value: number; subtitle: string; color: keyof typeof colorMap; icon: keyof typeof iconMap }>
  >([]);
  const [leaseRequests, setLeaseRequests] = useState<LeaseRow[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);

  useEffect(() => {
    // Loads dashboard cards, request snapshots, and warning alerts from backend data.
    async function loadDashboard() {
      try {
        const [assets, requests] = await Promise.all([
          apiFetch<Array<{ id: string; status: string; warranty_expiry: string | null }>>("/api/v1/assets"),
          apiFetch<Array<{ token_number: string; requestor_name: string; status: string; created_at: string; skus: string[] }>>(
            "/api/v1/lease-requests",
          ),
        ]);
        setSummaryCards([
          { title: "Total Assets", value: assets.length, subtitle: "All registered devices", color: "primary", icon: "Package" },
          { title: "Available", value: assets.filter((a) => a.status === "available").length, subtitle: "Ready to lease", color: "success", icon: "CheckCircle" },
          { title: "Leased", value: assets.filter((a) => a.status === "leased").length, subtitle: "Currently on lease", color: "info", icon: "ArrowRightLeft" },
          { title: "Under Repair", value: assets.filter((a) => a.status === "under_repair" || a.status === "repair").length, subtitle: "In maintenance", color: "warning", icon: "Wrench" },
        ]);
        setLeaseRequests(
          requests.slice(0, 8).map((r) => ({
            token: r.token_number,
            name: r.requestor_name,
            skus: (r.skus ?? []).join(", "),
            status:
              r.status === "approved"
                ? "Approved"
                : r.status === "rejected"
                  ? "Rejected"
                  : r.status === "active"
                    ? "Active"
                    : r.status === "closed"
                      ? "Closed"
                      : "Pending",
            date: r.created_at.slice(0, 10),
          })),
        );
        const now = new Date();
        const soon = new Date(now);
        soon.setDate(soon.getDate() + 30);
        const warrantyAlerts = assets
          .filter((a) => a.warranty_expiry)
          .filter((a) => {
            const d = new Date(a.warranty_expiry!);
            return !Number.isNaN(d.getTime()) && d >= now && d <= soon;
          })
          .slice(0, 5)
          .map((a) => ({
            type: "warranty" as const,
            message: `Warranty expires on ${a.warranty_expiry}`,
            date: a.warranty_expiry ?? "",
          }));
        const overdueAlerts = requests
          .filter((r) => r.status === "active")
          .slice(0, 3)
          .map((r) => ({
            type: "overdue" as const,
            message: `Active lease in progress: ${r.token_number} (${r.requestor_name})`,
            date: r.created_at.slice(0, 10),
          }));
        setAlerts([...warrantyAlerts, ...overdueAlerts]);
      } catch {
        setSummaryCards([
          { title: "Total Assets", value: 0, subtitle: "All registered devices", color: "primary", icon: "Package" },
          { title: "Available", value: 0, subtitle: "Ready to lease", color: "success", icon: "CheckCircle" },
          { title: "Leased", value: 0, subtitle: "Currently on lease", color: "info", icon: "ArrowRightLeft" },
          { title: "Under Repair", value: 0, subtitle: "In maintenance", color: "warning", icon: "Wrench" },
        ]);
      }
    }
    void loadDashboard();
  }, []);

  const safeAlerts = useMemo(() => alerts, [alerts]);

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {summaryCards.map((card) => {
          const Icon = iconMap[card.icon];
          const colors = colorMap[card.color];
          return (
            <Card key={card.title} className={`border-l-4 ${colors.border}`}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">{card.title}</p>
                    <p className="text-3xl font-bold text-foreground mt-1">{card.value}</p>
                    <p className="text-xs text-muted-foreground mt-1">{card.subtitle}</p>
                  </div>
                  <div className={`h-10 w-10 rounded-lg ${colors.bg} flex items-center justify-center`}>
                    <Icon className={`h-5 w-5 ${colors.text}`} />
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Two columns */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent Lease Requests */}
          <Card className="lg:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">Recent Lease Requests</CardTitle>
            </CardHeader>
          <CardContent className="p-0">
            <div className="hidden md:block overflow-x-auto">
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Token</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden md:table-cell">SKUs</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden sm:table-cell">Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leaseRequests.map((req) => (
                  <TableRow key={req.token}>
                    <TableCell className="font-mono text-xs">{req.token}</TableCell>
                    <TableCell className="font-medium">{req.name}</TableCell>
                    <TableCell className="hidden md:table-cell text-sm text-muted-foreground">{req.skus}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant[req.status]}>{req.status}</Badge>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">{req.date}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
            <div className="md:hidden space-y-3 p-4">
              {leaseRequests.map((req) => (
                <div key={req.token} className="rounded-lg border bg-card p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-mono text-xs font-bold text-foreground">{req.token}</p>
                    <Badge variant={statusVariant[req.status]}>{req.status}</Badge>
                  </div>
                  <p className="font-medium text-foreground">{req.name}</p>
                  <p className="text-sm text-muted-foreground">{req.skus}</p>
                  <p className="text-xs text-muted-foreground">{req.date}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Alerts */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">Alerts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {safeAlerts.map((alert, i) => (
              <div
                key={i}
                className={`p-3 rounded-lg border text-sm ${
                  alert.type === "warranty"
                    ? "bg-warning/5 border-warning/20"
                    : "bg-destructive/5 border-destructive/20"
                }`}
              >
                <div className="flex items-start gap-2">
                  {alert.type === "warranty" ? (
                    <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                  ) : (
                    <Clock className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                  )}
                  <div>
                    <p className="text-foreground leading-snug">{alert.message}</p>
                    <p className="text-xs text-muted-foreground mt-1">{alert.date}</p>
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
