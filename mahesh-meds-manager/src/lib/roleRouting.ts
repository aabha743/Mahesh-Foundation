export const ROLE_VIEW_PATHS: Record<string, string> = {
  master_admin: "/admin/dashboard",
  asset_manager: "/admin/assets",
  center_manager: "/center/dashboard",
  approver: "/approvals",
};

type RouteState = {
  activeRole: string | null;
  roles: string[];
  permissions: string[];
};

export function getRoleViewPath(role: string): string | null {
  return ROLE_VIEW_PATHS[role] ?? null;
}

export function resolveAdminHome(state: RouteState): string {
  if (state.activeRole === "asset_manager") {
    return ROLE_VIEW_PATHS.asset_manager;
  }
  return ROLE_VIEW_PATHS.master_admin;
}

export function resolveAuthenticatedHome(state: RouteState): string {
  if (state.activeRole) {
    return getRoleViewPath(state.activeRole) ?? "/login";
  }

  if (state.roles.includes("center_manager")) {
    return ROLE_VIEW_PATHS.center_manager;
  }
  if (state.roles.includes("approver")) {
    return ROLE_VIEW_PATHS.approver;
  }
  if (state.roles.includes("asset_manager") && !state.roles.includes("master_admin")) {
    return ROLE_VIEW_PATHS.asset_manager;
  }
  if (state.permissions.includes("users.manage")) {
    return ROLE_VIEW_PATHS.master_admin;
  }
  if (state.permissions.includes("assets.create") || state.permissions.includes("assets.update")) {
    return ROLE_VIEW_PATHS.asset_manager;
  }

  return "/login";
}
