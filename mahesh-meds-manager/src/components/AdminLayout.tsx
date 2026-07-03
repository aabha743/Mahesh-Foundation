import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Menu } from "lucide-react";
import { AppSidebar } from "./AppSidebar";
import { Button } from "@/components/ui/button";

const pageTitles: Record<string, string> = {
  "/admin/dashboard": "Dashboard",
  "/admin/assets": "Assets",
  "/admin/skus": "SKUs",
  "/admin/centers": "Centers",
  "/admin/users": "Users",
  "/admin/lease-requests": "Lease Requests",
  "/admin/reports": "Reports",
};

export function AdminLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  const pageTitle = pageTitles[location.pathname] || "Dashboard";
  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-background overflow-hidden">
      <AppSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex min-h-screen flex-col min-w-0 md:pl-64">
        {/* Header */}
        <header className="min-h-16 bg-card border-b border-border px-4 py-3 md:px-6 shrink-0">
          <div className="flex w-full items-center justify-between">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                onClick={() => setSidebarOpen(true)}
              >
                <Menu className="h-5 w-5" />
              </Button>
              <div>
                <h1 className="text-xl md:text-2xl font-semibold text-foreground">{pageTitle}</h1>
                <p className="text-xs text-muted-foreground hidden sm:block">{today}</p>
              </div>
            </div>
          </div>
        </header>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
