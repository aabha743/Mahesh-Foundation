import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { getMe, logout as apiLogout, type MeResponse } from "@/lib/api";

interface AuthContextType {
  user: MeResponse | null;
  permissions: string[];
  isLoading: boolean;
  isAuthenticated: boolean;
  activeRole: string | null;
  can: (permission: string) => boolean;
  hasRole: (role: string) => boolean;
  login: (user: MeResponse) => void;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  setActiveRole: (role: string) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

function getSessionActiveRole(): string | null {
  try { return sessionStorage.getItem("activeRole"); } catch { return null; }
}

function resolveActiveRole(userData: MeResponse): string | null {
  const stored = getSessionActiveRole();
  if (stored && userData.roles.includes(stored)) {
    return stored;
  }
  return userData.roles[0] ?? null;
}

function isPublicPath(pathname: string): boolean {
  if (pathname === "/" || pathname === "/login" || pathname === "/request" || pathname === "/status" || pathname === "/extend") {
    return true;
  }
  return pathname.startsWith("/track/");
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<MeResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeRole, setActiveRoleState] = useState<string | null>(getSessionActiveRole);
  const refreshInFlightRef = useRef(false);

  /**
   * Check if user has a specific permission.
   * Permissions are resolved by the backend and returned from /me.
   */
  const can = useCallback(
    (permission: string): boolean => {
      if (!user) return false;
      return user.permissions.includes(permission);
    },
    [user]
  );

  /**
   * Check if user has a specific role.
   */
  const hasRole = useCallback(
    (role: string): boolean => {
      if (!user) return false;
      return user.roles.includes(role);
    },
    [user]
  );

  const applyUserState = useCallback((userData: MeResponse | null) => {
    setUser(userData);
    if (!userData) {
      setActiveRoleState(null);
      try { sessionStorage.removeItem("activeRole"); } catch {/* */}
      return;
    }

    const resolvedRole = resolveActiveRole(userData);
    setActiveRoleState(resolvedRole);
    try {
      if (resolvedRole) {
        sessionStorage.setItem("activeRole", resolvedRole);
      } else {
        sessionStorage.removeItem("activeRole");
      }
    } catch {/* */}
  }, []);

  /**
   * Login: Set user data from /me response.
   */
  const login = useCallback((userData: MeResponse) => {
    applyUserState(userData);
  }, [applyUserState]);

  /**
   * Logout: Call API to revoke tokens, clear state.
   */
  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch (error) {
      console.error("Logout error:", error);
    } finally {
      applyUserState(null);
      window.location.replace("/login");
    }
  }, [applyUserState]);

  /**
   * Refresh: Re-fetch /me to update user data.
   */
  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try {
      const userData = await getMe();
      applyUserState(userData);
    } catch {
      applyUserState(null);
      if (typeof window !== "undefined" && !isPublicPath(window.location.pathname)) {
        window.location.replace("/login");
      }
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [applyUserState]);

  /**
   * On app load: Check if user has a valid session.
   * 401 is handled silently - user stays null, no redirect.
   */
  useEffect(() => {
    async function checkSession() {
      try {
        const userData = await getMe();
        applyUserState(userData);
      } catch {
        // 401 means not logged in - handled silently, stay on current page
        applyUserState(null);
      } finally {
        setIsLoading(false);
      }
    }

    checkSession();
  }, [applyUserState]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const revalidateSession = () => {
      if (document.visibilityState && document.visibilityState !== "visible") {
        return;
      }
      void refresh();
    };

    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        revalidateSession();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        revalidateSession();
      }
    };

    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("popstate", revalidateSession);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("popstate", revalidateSession);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refresh]);

  const setActiveRole = useCallback((role: string) => {
    setActiveRoleState(role);
    try { sessionStorage.setItem("activeRole", role); } catch {/* */}
  }, []);

  const value: AuthContextType = {
    user,
    permissions: user?.permissions ?? [],
    isLoading,
    isAuthenticated: !!user,
    activeRole,
    can,
    hasRole,
    login,
    logout,
    refresh,
    setActiveRole,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Hook to access auth context.
 * Must be used within AuthProvider.
 */
export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

/**
 * Higher-order component for protected routes.
 * Redirects to login if not authenticated.
 */
export function requireAuth(Component: React.ComponentType) {
  return function AuthenticatedComponent(props: Record<string, unknown>) {
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

    return <Component {...props} />;
  };
}

/**
 * Higher-order component for permission-based routes.
 * Shows access denied if user lacks permission.
 */
export function requirePermission(permission: string) {
  return function (Component: React.ComponentType) {
    return function PermissionGuard(props: Record<string, unknown>) {
      const { can, isLoading, isAuthenticated } = useAuth();

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

      if (!can(permission)) {
        return (
          <div className="min-h-screen flex flex-col items-center justify-center p-4">
            <h1 className="text-2xl font-bold text-foreground mb-2">Access Denied</h1>
            <p className="text-muted-foreground">
              You don't have permission to view this page.
            </p>
          </div>
        );
      }

      return <Component {...props} />;
    };
  };
}

export function requireAnyPermission(...permissions: string[]) {
  return function (Component: React.ComponentType) {
    return function PermissionGuard(props: Record<string, unknown>) {
      const { can, isLoading, isAuthenticated } = useAuth();

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

      if (!permissions.some((permission) => can(permission))) {
        return (
          <div className="min-h-screen flex flex-col items-center justify-center p-4">
            <h1 className="text-2xl font-bold text-foreground mb-2">Access Denied</h1>
            <p className="text-muted-foreground">
              You don't have permission to view this page.
            </p>
          </div>
        );
      }

      return <Component {...props} />;
    };
  };
}
