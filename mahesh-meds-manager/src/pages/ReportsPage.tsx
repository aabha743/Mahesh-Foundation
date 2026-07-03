import { useCallback, useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";

// Converts rows into downloadable CSV and triggers browser download.
function exportCSV(headers: string[], rows: string[][], filename: string) {
  const csv = [headers.join(","), ...rows.map((r) => r.map((c) => `"${c}"`).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  toast.success(`Exported ${filename}`);
}

type AuditLog = {
  id: string;
  user_id: string | null;
  center_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
  section: "requests" | "centers" | "approver" | "admin";
  user_name?: string | null;
  center_name?: string | null;
};

const sectionTabs = [
  { value: "requests", label: "Requests & Token Timeline" },
  { value: "centers", label: "Center Operations" },
  { value: "approver", label: "Approver Decisions" },
  { value: "admin", label: "Admin Activity" },
] as const;

export default function ReportsPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [activeSection, setActiveSection] = useState<(typeof sectionTabs)[number]["value"]>("requests");
  const [tokenFilter, setTokenFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [loading, setLoading] = useState(false);

  // Fetches audit logs from backend with optional date range.
  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", "500");
      if (startDate) params.set("start_at", startDate);
      if (endDate) params.set("end_at", endDate);
      const data = await apiFetch<AuditLog[]>(`/api/v1/audit-logs?${params.toString()}`);
      setLogs(data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load activity ledger");
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const sectionLogs = useMemo(() => logs.filter((log) => log.section === activeSection), [logs, activeSection]);

  const actions = useMemo(
    () => Array.from(new Set(sectionLogs.map((log) => log.action))).sort((a, b) => a.localeCompare(b)),
    [sectionLogs],
  );

  const filtered = useMemo(() => {
    return sectionLogs.filter((log) => {
      const tokenValue =
        (typeof log.new_value?.token === "string" ? log.new_value.token : "") ||
        (typeof log.old_value?.token === "string" ? log.old_value.token : "");
      const tokenMatch = !tokenFilter.trim() || tokenValue.toLowerCase().includes(tokenFilter.trim().toLowerCase());
      const actionMatch = actionFilter === "all" || log.action === actionFilter;
      return tokenMatch && actionMatch;
    });
  }, [sectionLogs, tokenFilter, actionFilter]);

  // Exports currently visible section rows with active filters.
  const exportActiveSection = () => {
    exportCSV(
      ["Timestamp", "Action", "Entity", "Entity ID", "Token", "Actor", "Role", "Center", "IP"],
      filtered.map((log) => [
        new Date(log.created_at).toLocaleString(),
        log.action,
        log.entity_type,
        log.entity_id ?? "",
        String(log.new_value?.token ?? log.old_value?.token ?? ""),
        String(log.user_name ?? log.new_value?.actor_mobile ?? ""),
        String(log.new_value?.actor_role ?? ""),
        String(log.center_name ?? log.center_id ?? ""),
        log.ip_address ?? "",
      ]),
      `activity-ledger-${activeSection}.csv`,
    );
  };

  return (
    <Tabs value={activeSection} onValueChange={(value) => setActiveSection(value as typeof activeSection)} className="space-y-4">
      <TabsList className="flex-wrap">
        {sectionTabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>

      {sectionTabs.map((tab) => (
        <TabsContent key={tab.value} value={tab.value}>
        <Card>
          <CardHeader className="flex flex-col items-start justify-between pb-3 gap-3 md:flex-row md:items-center">
            <div className="flex w-full flex-col gap-2">
              <CardTitle className="text-base md:text-lg">{tab.label}</CardTitle>
              <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
              <Input
                placeholder="Filter by token"
                className="h-10 w-full md:w-[180px]"
                value={tokenFilter}
                onChange={(e) => setTokenFilter(e.target.value)}
              />
              <Input type="date" className="h-10 w-full md:w-[150px]" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              <Input type="date" className="h-10 w-full md:w-[150px]" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              <Select value={actionFilter} onValueChange={setActionFilter}>
                <SelectTrigger className="h-10 w-full md:w-[200px]">
                  <SelectValue placeholder="Filter action" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All actions</SelectItem>
                  {actions.map((action) => (
                    <SelectItem key={action} value={action}>
                      {action}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              </div>
            </div>
            <div className="flex w-full flex-col gap-2 md:w-auto md:flex-row md:items-center">
              <Button variant="outline" size="sm" onClick={loadLogs} disabled={loading} className="w-full md:w-auto">
                Refresh
              </Button>
              <Button variant="outline" size="sm" onClick={exportActiveSection} className="w-full md:w-auto">
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Export CSV
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="hidden md:block overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Timestamp</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead className="hidden md:table-cell">Token</TableHead>
                <TableHead className="hidden lg:table-cell">Actor</TableHead>
                <TableHead className="hidden lg:table-cell">Role</TableHead>
                <TableHead className="hidden xl:table-cell">Center</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {filtered.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="text-muted-foreground">{new Date(log.created_at).toLocaleString()}</TableCell>
                    <TableCell><Badge variant="secondary">{log.action}</Badge></TableCell>
                    <TableCell>{log.entity_type}</TableCell>
                    <TableCell className="hidden md:table-cell font-mono text-xs">
                      {String(log.new_value?.token ?? log.old_value?.token ?? "-")}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">{String(log.user_name ?? log.new_value?.actor_mobile ?? "public")}</TableCell>
                    <TableCell className="hidden lg:table-cell">{String(log.new_value?.actor_role ?? "-")}</TableCell>
                    <TableCell className="hidden xl:table-cell">{log.center_name ?? log.center_id ?? "-"}</TableCell>
                  </TableRow>
                ))}
                {!filtered.length && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      {loading ? "Loading activity..." : "No activity found for filters"}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            </div>

            <div className="md:hidden space-y-3 p-4">
              {filtered.map((log) => (
                <div key={log.id} className="rounded-lg border bg-card p-4 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-medium text-foreground">{log.action.replace(/_/g, " ")}</p>
                    <Badge variant="secondary">{log.entity_type}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Actor: <span className="text-foreground">{String(log.user_name ?? log.new_value?.actor_mobile ?? "public")}</span>
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Time: <span className="text-foreground">{new Date(log.created_at).toLocaleString()}</span>
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {String(log.new_value?.token ?? log.old_value?.token ?? "-")}
                  </p>
                </div>
              ))}
              {!filtered.length && (
                <div className="text-center py-8 text-muted-foreground">
                  {loading ? "Loading activity..." : "No activity found for filters"}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </TabsContent>
      ))}
    </Tabs>
  );
}
