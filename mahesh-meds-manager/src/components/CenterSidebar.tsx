import { useLocation, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Package,
  Send,
  CornerDownLeft,
  ArrowLeftRight,
  ClipboardList,
  LogOut,
  X,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { BrandLogo } from "@/components/BrandLogo";
import { useAuth } from "@/hooks/useAuth";
import { getUserDisplayName, getUserInitials } from "@/lib/userDisplay";

const navItems = [
  { title: "Dashboard", path: "/center/dashboard", icon: LayoutDashboard, permissions: [] },
  { title: "Assets", path: "/center/inventory", icon: Package, permissions: ["assets.create", "assets.update"] },
  { title: "Issue Device", path: "/center/issue", icon: Send, permissions: ["devices.issue"] },
  { title: "Return Device", path: "/center/return", icon: CornerDownLeft, permissions: ["devices.collect"] },
  { title: "Lease Tracking", path: "/center/lease-requests", icon: ClipboardList, permissions: ["devices.issue", "devices.collect", "requests.edit"] },
  // { title: "Transfer Asset", path: "/center/transfer", icon: ArrowRightLeft, permissions: ["assets.transfer"] },
];

interface CenterSidebarProps {
  open: boolean;
  onClose: () => void;
}

export function CenterSidebar({ open, onClose }: CenterSidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, can, hasRole, logout } = useAuth();
  const isAssetManager = hasRole("asset_manager") && !hasRole("center_manager");
  const hasMultipleRoles = user ? user.roles.length > 1 : false;
  const avatarText = getUserInitials(user, "CA");
  const displayName = getUserDisplayName(user, "Center Staff");
  const visibleNavItems = navItems.filter((item) => item.permissions.length === 0 || item.permissions.some((permission) => can(permission)));

  const handleNav = (path: string) => {
    navigate(path);
    onClose();
  };

  const handleLogout = async () => {
    await logout();
  };

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={onClose} />
      )}
      <aside
        className={`
          fixed top-0 left-0 z-50 h-full md:h-screen w-72 md:w-64 bg-sidebar-bg flex flex-col
          transition-transform duration-300 ease-in-out
          md:translate-x-0 md:z-30
          ${open ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        <div className="relative flex min-h-[5.75rem] items-center justify-center px-5 py-4 border-b border-sidebar-border-color">
          <BrandLogo
            className="w-full justify-center"
            imageClassName="h-16 w-full max-w-[13.75rem] rounded-sm bg-transparent object-fill"
          />
          <button onClick={onClose} className="absolute right-4 md:hidden text-sidebar-fg/70 hover:text-sidebar-fg">
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="app-sidebar-scroll flex-1 px-3 py-4 space-y-1.5 overflow-y-auto overscroll-contain">
          {visibleNavItems.map((item) => {
            const isActive = location.pathname === item.path;
            return (
              <button
                key={item.path}
                onClick={() => handleNav(item.path)}
                className={`
                  w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors
                  ${isActive
                    ? "bg-sidebar-accent-bg text-sidebar-fg"
                    : "text-sidebar-fg/70 hover:bg-sidebar-accent-bg/50 hover:text-sidebar-fg"
                  }
                `}
              >
                <item.icon className="h-4.5 w-4.5 shrink-0" />
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
              <p className="text-xs text-sidebar-fg/60">{isAssetManager ? "Asset Manager" : "Center Manager"}</p>
            </div>
          </div>
          {hasMultipleRoles && (
            <button
              onClick={() => {
                navigate("/view-selector");
                onClose();
              }}
              className="w-full flex items-center gap-3 px-3 py-2 mt-1 rounded-md text-sm text-sidebar-fg/70 hover:bg-sidebar-accent-bg/50 hover:text-sidebar-fg transition-colors"
            >
              <ArrowLeftRight className="h-4 w-4" />
              <span>Switch view</span>
            </button>
          )}
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3 py-2 mt-1 rounded-md text-sm text-sidebar-fg/70 hover:bg-sidebar-accent-bg/50 hover:text-sidebar-fg transition-colors"
          >
            <LogOut className="h-4 w-4" />
            <span>Logout</span>
          </button>
        </div>
      </aside>
    </>
  );
}
