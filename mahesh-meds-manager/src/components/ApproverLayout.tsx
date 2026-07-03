import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Menu, ClipboardCheck, CheckSquare, LogOut, X, ArrowLeftRight, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { BrandLogo } from "@/components/BrandLogo";
import { useAuth } from "@/hooks/useAuth";
import { getUserDisplayName, getUserInitials } from "@/lib/userDisplay";

const navItems = [
  { title: "Approvals", path: "/approvals", icon: ClipboardCheck },
  { title: "Reviewed", path: "/approvals?tab=reviewed", icon: CheckSquare },
  { title: "Extensions", path: "/approvals/extensions", icon: CalendarClock },
];

export function ApproverLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const hasMultipleRoles = user ? user.roles.length > 1 : false;
  const avatarText = getUserInitials(user, "AP");
  const displayName = getUserDisplayName(user, "Approver User");

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-background overflow-hidden">
      {/* Overlay */}
      {sidebarOpen && <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} />}

      {/* Minimal sidebar */}
      <aside className={`fixed top-0 left-0 z-50 h-full md:h-screen w-64 md:w-64 bg-sidebar-bg flex flex-col transition-transform duration-300 md:translate-x-0 md:z-30 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="relative flex min-h-[5.75rem] items-center justify-center px-5 py-4 border-b border-sidebar-border-color">
          <BrandLogo
            className="w-full justify-center"
            imageClassName="h-16 w-full max-w-[13.75rem] rounded-sm bg-transparent object-fill"
          />
          <button onClick={() => setSidebarOpen(false)} className="absolute right-4 md:hidden text-sidebar-fg/70 hover:text-sidebar-fg"><X className="h-5 w-5" /></button>
        </div>

        <nav className="app-sidebar-scroll flex-1 px-3 py-4 space-y-1.5 overflow-y-auto overscroll-contain">
          {navItems.map((item) => {
            const isActive =
              item.path === "/approvals"
                ? location.pathname === "/approvals" && !location.search.includes("tab=reviewed")
                : item.path === "/approvals?tab=reviewed"
                  ? location.search.includes("tab=reviewed")
                  : location.pathname === "/approvals/extensions";
            return (
              <button key={item.title} onClick={() => { navigate(item.path); setSidebarOpen(false); }}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${isActive ? "bg-sidebar-accent-bg text-sidebar-fg" : "text-sidebar-fg/70 hover:bg-sidebar-accent-bg/50 hover:text-sidebar-fg"}`}>
                <item.icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{item.title}</span>
              </button>
            );
          })}
        </nav>

        <div className="px-3 py-4 border-t border-sidebar-border-color">
          <div className="flex items-center gap-3 px-3 py-2">
            <Avatar className="h-8 w-8 bg-sidebar-accent-bg text-sidebar-fg">
              <AvatarFallback className="bg-sidebar-accent-bg text-sidebar-fg text-xs font-semibold">{avatarText}</AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-sidebar-fg truncate">{displayName}</p>
              <p className="text-xs text-sidebar-fg/60">Approver</p>
            </div>
          </div>
          {hasMultipleRoles && (
            <button
              onClick={() => {
                navigate("/view-selector");
                setSidebarOpen(false);
              }}
              className="w-full flex items-center gap-3 px-3 py-2 mt-1 rounded-md text-sm text-sidebar-fg/70 hover:bg-sidebar-accent-bg/50 hover:text-sidebar-fg transition-colors"
            >
              <ArrowLeftRight className="h-4 w-4" />
              <span>Switch view</span>
            </button>
          )}
          <button onClick={async () => { await logout(); }} className="w-full flex items-center gap-3 px-3 py-2 mt-1 rounded-md text-sm text-sidebar-fg/70 hover:bg-sidebar-accent-bg/50 hover:text-sidebar-fg transition-colors">
            <LogOut className="h-4 w-4" /><span>Logout</span>
          </button>
        </div>
      </aside>

      <div className="flex min-h-screen flex-col min-w-0 md:pl-64">
        <header className="min-h-14 bg-card border-b border-border px-4 py-3 md:px-6 shrink-0">
          <div className="flex w-full items-center">
            <Button variant="ghost" size="icon" className="md:hidden mr-2" onClick={() => setSidebarOpen(true)}><Menu className="h-5 w-5" /></Button>
            <h1 className="text-xl md:text-2xl font-semibold text-foreground">
              {location.pathname === "/approvals/extensions" ? "Lease Extension Reviews" : "Lease Request Approvals"}
            </h1>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-6"><Outlet /></main>
      </div>
    </div>
  );
}
