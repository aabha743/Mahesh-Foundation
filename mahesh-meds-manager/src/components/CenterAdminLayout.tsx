import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Menu, Building2 } from "lucide-react";
import { CenterSidebar } from "./CenterSidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCenterScope } from "@/hooks/useCenterScope";

const pageTitles: Record<string, string> = {
  "/center/dashboard": "Dashboard",
  "/center/inventory": "Assets",
  "/center/issue": "Issue Device",
  "/center/return": "Return Device",
  "/center/lease-requests": "Lease Requests",
};

export function CenterAdminLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { centers, centerId, centerName, setCenterId, loading } = useCenterScope();
  const location = useLocation();
  const pageTitle = pageTitles[location.pathname] || "Dashboard";
  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-background overflow-hidden">
      <CenterSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex min-h-screen flex-col min-w-0 md:pl-64">
        <header className="min-h-16 bg-card border-b border-border px-4 py-3 md:px-6 shrink-0">
          <div className="w-full flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <Button variant="ghost" size="icon" className="md:hidden shrink-0" onClick={() => setSidebarOpen(true)}>
                <Menu className="h-5 w-5" />
              </Button>
              <div className="min-w-0 flex-1">
                <h1 className="text-xl md:text-2xl font-semibold text-foreground">{pageTitle}</h1>
                <p className="text-xs text-muted-foreground hidden sm:block">{today}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2 sm:hidden">
                  <Badge variant="secondary" className="items-center gap-1 max-w-full">
                    <Building2 className="h-3 w-3" />
                    <span className="truncate">{loading ? "..." : centerName}</span>
                  </Badge>
                </div>
              </div>
            </div>
            <div className="hidden sm:flex items-center gap-2">
              <Badge variant="secondary" className="items-center gap-1">
                <Building2 className="h-3 w-3" />
                {loading ? "..." : centerName}
              </Badge>
              {centers.length > 1 && centerId && (
                <Select value={centerId} onValueChange={setCenterId}>
                  <SelectTrigger className="h-8 w-[200px] text-xs"><SelectValue placeholder="Center" /></SelectTrigger>
                  <SelectContent>
                    {centers.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
          {centers.length > 1 && centerId && (
            <div className="mt-3 sm:hidden">
              <Select value={centerId} onValueChange={setCenterId}>
                <SelectTrigger className="h-9 w-full text-xs"><SelectValue placeholder="Center" /></SelectTrigger>
                <SelectContent>
                  {centers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </header>
        <main className="flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
