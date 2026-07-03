import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StickerPrintHost } from "@/components/StickerPrintHost";
import Index from "./pages/Index";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import AssetsPage from "./pages/AssetsPage";
import NewAssetPage from "./pages/NewAssetPage";
import SKUsPage from "./pages/SKUsPage";
import CentersPage from "./pages/CentersPage";
import UsersPage from "./pages/UsersPage";
import LeaseRequestsPage from "./pages/LeaseRequestsPage";
import ReportsPage from "./pages/ReportsPage";
import { AdminLayout } from "./components/AdminLayout";
import { CenterAdminLayout } from "./components/CenterAdminLayout";
import CenterDashboard from "./pages/center/CenterDashboard";
import CenterInventory from "./pages/center/CenterInventory";
import IssueDevice from "./pages/center/IssueDevice";
import ReturnDevice from "./pages/center/ReturnDevice";
// import TransferAsset from "./pages/center/TransferAsset";
import CenterLeaseRequests from "./pages/center/CenterLeaseRequests";
import { ApproverLayout } from "./components/ApproverLayout";
import ApprovalsList from "./pages/approver/ApprovalsList";
import ApprovalDetail from "./pages/approver/ApprovalDetail";
import LeaseRequestForm from "./pages/public/LeaseRequestForm";
import LeaseExtensionForm from "./pages/public/LeaseExtensionForm";
import RequestStatus from "./pages/public/RequestStatus";
import LeaseExtensionsReview from "./pages/approver/LeaseExtensionsReview";
import NotFound from "./pages/NotFound";
import ViewSelector from "./pages/ViewSelector";
import { AuthProvider, useAuth, requireAnyPermission, requirePermission } from "@/hooks/useAuth";
import { resolveAdminHome, resolveAuthenticatedHome } from "@/lib/roleRouting";

const queryClient = new QueryClient();

// Create permission-guarded components
const UsersPageWithAuth = requirePermission("users.manage")(UsersPage);
const CentersPageWithAuth = requirePermission("centers.manage")(CentersPage);
const SKUsPageWithAuth = requirePermission("skus.manage")(SKUsPage);
const AuditPageWithAuth = requirePermission("audit.view")(ReportsPage);
const AssetsPageWithAuth = requireAnyPermission("assets.create", "assets.update")(AssetsPage);
const NewAssetPageWithAuth = requireAnyPermission("assets.create", "assets.update")(NewAssetPage);
const IssueDeviceWithAuth = requirePermission("devices.issue")(IssueDevice);
const CollectDeviceWithAuth = requirePermission("devices.collect")(ReturnDevice);
const LeaseRequestsPageWithAuth = requirePermission("requests.edit")(LeaseRequestsPage);

/**
 * Authentication guard - redirects to login if not authenticated.
 * Used for all protected routes.
 */
function AuthGuard({ children }: { children: ReactElement }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return children;
}

/**
 * Center access guard - checks permissions for center routes.
 * Allows: center_manager and master_admin only.
 */
function CenterAccessGuard({ children }: { children: ReactElement }) {
  const location = useLocation();
  const { can, hasRole, activeRole, isLoading, isAuthenticated } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // Check center role
  const isCenterManager = hasRole("center_manager");
  const isMasterAdmin = hasRole("master_admin");

  if (!isCenterManager && !isMasterAdmin) {
    return <Navigate to="/login" replace />;
  }

  if (activeRole && activeRole !== "center_manager" && activeRole !== "master_admin") {
    return <Navigate to="/view-selector" replace />;
  }

  const routePermissions: Record<string, string[]> = {
    "/center/dashboard": [],
    "/center/inventory": ["assets.create", "assets.update"],
    "/center/issue": ["devices.issue"],
    "/center/return": ["devices.collect"],
    "/center/lease-requests": ["devices.issue", "devices.collect", "requests.edit"],
  };

  const requiredPermissions = routePermissions[location.pathname];
  if (requiredPermissions && requiredPermissions.length > 0 && !requiredPermissions.some((permission) => can(permission))) {
    const fallbackPath =
      (routePermissions["/center/dashboard"]?.length === 0 ? "/center/dashboard" : null) ??
      ["/center/issue", "/center/return"].find((path) =>
        (routePermissions[path] ?? []).some((permission) => can(permission)),
      ) ??
      Object.entries(routePermissions).find(([, permissions]) =>
        permissions.some((permission) => can(permission)),
      )?.[0] ??
      "/login";
    return <Navigate to={fallbackPath} replace />;
  }

  return children;
}

/**
 * Admin access guard - allows master admin and asset manager flows.
 */
function AdminAccessGuard({ children }: { children: ReactElement }) {
  const { hasRole, activeRole, isLoading, isAuthenticated } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (!hasRole("master_admin") && !hasRole("asset_manager")) {
    return <Navigate to="/login" replace />;
  }

  if (activeRole && activeRole !== "master_admin" && activeRole !== "asset_manager") {
    return <Navigate to="/view-selector" replace />;
  }

  return children;
}

function AdminHomeRedirect() {
  const { activeRole, user } = useAuth();
  const path = resolveAdminHome({
    activeRole,
    roles: user?.roles ?? [],
    permissions: user?.permissions ?? [],
  });
  return <Navigate to={path} replace />;
}

function AuthenticatedHomeRedirect() {
  const { activeRole, user } = useAuth();
  const path = resolveAuthenticatedHome({
    activeRole,
    roles: user?.roles ?? [],
    permissions: user?.permissions ?? [],
  });
  return <Navigate to={path} replace />;
}

function AdminDashboardRoute() {
  const { can } = useAuth();

  if (!can("users.manage")) {
    return <Navigate to="/admin/assets" replace />;
  }

  return <Dashboard />;
}

/**
 * Approver access guard - requires approver mode plus approve/reject permission.
 */
function ApproverAccessGuard({ children }: { children: ReactElement }) {
  const { can, activeRole, isLoading, isAuthenticated } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // Check for approver permissions
  if (!can("requests.approve") && !can("requests.reject")) {
    return <Navigate to="/login" replace />;
  }

  if (activeRole && activeRole !== "approver") {
    return <Navigate to="/view-selector" replace />;
  }

  return children;
}

// Root application shell: providers + role-specific route tree.
const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <StickerPrintHost />
        <BrowserRouter>
          <Routes>
            {/* Public routes (GROUP A) */}
            <Route path="/" element={<Index />} />
            <Route path="/login" element={<Login />} />
            <Route path="/view-selector" element={<AuthGuard><ViewSelector /></AuthGuard>} />
            <Route path="/request" element={<LeaseRequestForm />} />
            <Route path="/status" element={<RequestStatus />} />
            <Route path="/track/:token" element={<RequestStatus />} />
            <Route path="/extend" element={<LeaseExtensionForm />} />

            {/* Authenticated routes (GROUP B) */}
            <Route path="/dashboard" element={<AuthGuard><AuthenticatedHomeRedirect /></AuthGuard>} />
            <Route path="/profile" element={<AuthGuard><div>Profile Page (Placeholder)</div></AuthGuard>} />

            {/* Permission-based routes (GROUP C) */}
            <Route path="/admin" element={<AdminAccessGuard><AdminLayout /></AdminAccessGuard>}>
              <Route index element={<AdminHomeRedirect />} />
              <Route path="dashboard" element={<AdminDashboardRoute />} />
              <Route path="assets">
                <Route index element={<AssetsPageWithAuth />} />
                <Route path="new" element={<NewAssetPageWithAuth />} />
              </Route>
              <Route path="skus" element={<SKUsPageWithAuth />} />
              <Route path="centers" element={<CentersPageWithAuth />} />
              <Route path="users" element={<UsersPageWithAuth />} />
              <Route path="lease-requests">
                <Route index element={<LeaseRequestsPageWithAuth />} />
                <Route path=":id" element={<LeaseRequestsPageWithAuth />} />
                <Route path=":id/issue" element={<IssueDeviceWithAuth />} />
              </Route>
              <Route path="reports" element={<AuditPageWithAuth />} />
              <Route path="audit" element={<AuditPageWithAuth />} />
            </Route>

            {/* Top-level redirects for better UX/compatibility */}
            <Route path="/assets" element={<Navigate to="/admin/assets" replace />} />
            <Route path="/requests" element={<Navigate to="/admin/lease-requests" replace />} />

            {/* Center routes - requires center_manager role (or master_admin override) */}
            <Route path="/center" element={<CenterAccessGuard><CenterAdminLayout /></CenterAccessGuard>}>
              <Route path="dashboard" element={<CenterDashboard />} />
              <Route path="inventory" element={<CenterInventory />} />
              <Route path="issue" element={<IssueDevice />} />
              <Route path="return" element={<ReturnDevice />} />
              <Route path="lease-requests" element={<CenterLeaseRequests />} />
            </Route>

            {/* Approver routes - requires requests.approve/reject permission */}
            <Route path="/approvals" element={<ApproverAccessGuard><ApproverLayout /></ApproverAccessGuard>}>
              <Route index element={<ApprovalsList />} />
              <Route path="extensions" element={<LeaseExtensionsReview />} />
              <Route path=":id" element={<ApprovalDetail />} />
            </Route>

            {/* 404 */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
