import { toast } from "sonner";

/**
 * Dev: leave VITE_API_URL unset (or empty) to use the Vite proxy — same origin on
 * localhost and on your phone at http://<LAN-IP>:8080.
 * Prod: leave unset for same-origin deployments, or set VITE_API_URL to the
 * full backend URL when the API is hosted on a different origin.
 */
function resolveApiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  if (import.meta.env.DEV) return "";
  return "";
}

const API_BASE_URL = resolveApiBaseUrl();

/**
 * Get CSRF token from cookies.
 * The csrf_token cookie is set on login and readable by JavaScript.
 */
function getCsrfToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(/csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

/**
 * Check if HTTP method requires CSRF protection.
 * GET requests are exempt from CSRF protection.
 */
function requiresCsrf(method?: string): boolean {
  const m = (method ?? "GET").toUpperCase();
  return m === "POST" || m === "PATCH" || m === "PUT" || m === "DELETE";
}

function buildHeaders(init?: ApiFetchOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string>),
  };

  if (requiresCsrf(init?.method)) {
    const csrfToken = getCsrfToken();
    if (csrfToken) {
      headers["X-CSRF-Token"] = csrfToken;
    }
  }

  return headers;
}

/**
 * Global error handler for API responses.
 * - 401: User not authenticated, redirect to login (unless skipAuthRedirect is true)
 * - 403: Permission denied, show error toast
 */
function handleApiError(response: Response, errorText: string, skipAuthRedirect?: boolean): never {
  if (response.status === 401) {
    // Only redirect if this isn't an auth check call
    // Auth check calls (like /me) should fail silently on 401
    if (!skipAuthRedirect) {
      window.location.href = "/login";
    }
    throw new Error("Session expired. Please log in again.");
  }

  if (response.status === 403) {
    toast.error("You don't have permission to perform this action");
    throw new Error(errorText || "Permission denied");
  }

  if (response.status >= 500) {
    toast.error("Something went wrong. Please try again.");
    throw new Error(errorText || "Server error");
  }

  throw new Error(errorText || `Request failed with status ${response.status}`);
}

function extractErrorMessage(errorText: string): string {
  if (!errorText) {
    return "";
  }

  try {
    const parsed = JSON.parse(errorText) as { detail?: string };
    if (typeof parsed.detail === "string" && parsed.detail.trim()) {
      return parsed.detail;
    }
  } catch {
    // Fall back to the original response text.
  }

  return errorText;
}

/**
 * Extended RequestInit with custom options for API fetch.
 */
interface ApiFetchOptions extends RequestInit {
  skipAuthRedirect?: boolean; // Don't redirect to login on 401 (for auth checks)
}

/**
 * Shared API helper for JWT cookie auth with CSRF protection.
 *
 * Features:
 * - credentials: "include" sends HttpOnly cookies automatically
 * - X-CSRF-Token header on state-changing requests (POST, PATCH, DELETE)
 * - Automatic token refresh on 401
 * - Global 401/403 error handling
 */
export async function apiFetch<T>(
  path: string,
  init?: ApiFetchOptions
): Promise<T> {
  const url = `${API_BASE_URL}${path}`;

  let headers = buildHeaders(init);

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: "include", // Send HttpOnly cookies automatically
      headers,
    });
  } catch (error) {
    toast.error("Something went wrong. Please try again.");
    throw error;
  }

  // Handle 401 by attempting token refresh (except for auth endpoints)
  if (response.status === 401 && !path.includes("/auth/")) {
    // Try to refresh
    const refreshHeaders = buildHeaders({ method: "POST" });
    const refreshed = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers: refreshHeaders,
    });

    if (refreshed.ok) {
      // Re-read CSRF token in case it was rotated
      headers = buildHeaders(init);
      // Retry the original request
      response = await fetch(url, {
        ...init,
        credentials: "include",
        headers,
      });
    } else {
      // Refresh failed, redirect to login unless it's /me
      if (!path.includes("/me") && !init?.skipAuthRedirect) {
        window.location.href = "/login";
      }
      throw new Error("Session expired");
    }
  }

  if (!response.ok) {
    const errorText = extractErrorMessage(await response.text());
    handleApiError(response, errorText, init?.skipAuthRedirect);
  }

  // Handle empty responses (e.g., 204 No Content)
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

// Auth API functions
export interface OTPRequest {
  mobile: string;
}

export interface OTPVerify {
  mobile: string;
  otp: string;
}

export interface MeResponse {
  id: string;
  name: string;
  mobile: string;
  center_id: string | null;
  roles: string[];
  permissions: string[];
}

export interface Permission {
  id: string;
  action: string;
  description: string;
}

export interface Role {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
}

export interface LeaseRequestTokenLookup {
  id: string;
  token_number: string;
  status: string;
  requestor_name: string;
  mobile: string;
  aadhar_number: string;
  patient_name?: string | null;
  delivery_address?: string | null;
  delivery_landmark?: string | null;
  reference_name?: string | null;
  preferred_center_id: string | null;
  created_at: string;
  updated_at: string;
  due_date: string | null;
  expected_duration: string | null;
  rejection_reason: string | null;
  approval_comments: string | null;
  notes: string | null;
  fulfillment_centers: Array<{
    center_id: string;
    center_name: string;
    item_count: number;
    item_names: string[];
  }>;
  fulfillment_message: string | null;
  extension_eligible: boolean;
  extension_eligibility_reason: string | null;
  pending_extension_request: boolean;
  latest_extension: {
    id: string;
    status: string;
    requested_duration: string;
    requested_days: number;
    requested_due_date: string | null;
    current_due_date: string;
    approved_due_date: string | null;
    requested_at: string;
    reviewed_at: string | null;
    reviewed_by: string | null;
  } | null;
  extension_history: Array<{
    id: string;
    status: string;
    requested_duration: string;
    requested_days: number;
    requested_due_date: string | null;
    current_due_date: string;
    approved_due_date: string | null;
    requested_at: string;
    reviewed_at: string | null;
    reviewed_by: string | null;
    reason: string | null;
    rejection_reason: string | null;
  }>;
  skus: string[];
  items?: Array<{
    sku_id: string;
    sku_name: string;
    quantity_requested: number;
    asset_id: string | null;
    due_date: string | null;
  }>;
}

export interface LeaseExtensionCreatePayload {
  token_number: string;
  requestor_name: string;
  mobile: string;
  aadhar_number: string;
  requested_due_date: string;
  requested_duration?: string;
  reason?: string;
}

export interface LeaseExtension {
  id: string;
  lease_request_id: string;
  token_number: string;
  status: "pending" | "approved" | "rejected";
  requested_duration: string;
  requested_days: number;
  requested_due_date: string | null;
  reason: string | null;
  requestor_name: string;
  mobile: string;
  aadhar_number: string;
  current_due_date: string;
  approved_due_date: string | null;
  approver_comments: string | null;
  rejection_reason: string | null;
  requested_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

export interface CenterActivityLog {
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
  section?: string;
  user_name?: string | null;
}

export async function requestOTP(mobile: string): Promise<{ message: string; expires_in: number; debug_otp?: string }> {
  return apiFetch("/auth/request-otp", {
    method: "POST",
    body: JSON.stringify({ mobile }),
    skipAuthRedirect: true,
  });
}

export async function verifyOTP(mobile: string, otp: string): Promise<{ message: string }> {
  return apiFetch("/auth/verify-otp", {
    method: "POST",
    body: JSON.stringify({ mobile, otp }),
    skipAuthRedirect: true,
  });
}

export async function getMe(): Promise<MeResponse> {
  return apiFetch("/me", {
    skipAuthRedirect: true, // Don't redirect to login on 401 - this is an auth check
  });
}

export async function logout(): Promise<{ message: string }> {
  return apiFetch("/auth/logout", {
    method: "POST",
  });
}

export async function refreshToken(): Promise<{ message: string; csrf_token: string }> {
  return apiFetch("/auth/refresh", {
    method: "POST",
  });
}

export async function getLeaseRequestByToken(token: string): Promise<LeaseRequestTokenLookup> {
  return apiFetch(`/api/v1/lease-requests/by-token/${encodeURIComponent(token)}`);
}

export async function getLeaseRequestsByMobile(mobile: string): Promise<LeaseRequestTokenLookup[]> {
  return apiFetch(`/api/v1/lease-requests/by-mobile/${encodeURIComponent(mobile)}`);
}

export async function createLeaseExtension(payload: LeaseExtensionCreatePayload): Promise<LeaseExtension> {
  return apiFetch("/api/v1/lease-extensions", {
    method: "POST",
    body: JSON.stringify(payload),
    skipAuthRedirect: true,
  });
}

export async function listLeaseExtensions(status?: string): Promise<LeaseExtension[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return apiFetch(`/api/v1/lease-extensions${query}`);
}

export async function reviewLeaseExtension(
  extensionId: string,
  payload: { status: "approved" | "rejected"; approver_comments?: string; rejection_reason?: string }
): Promise<LeaseExtension> {
  return apiFetch(`/api/v1/lease-extensions/${extensionId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function listCenterActivity(limit = 10, section?: string): Promise<CenterActivityLog[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (section) params.set("section", section);
  return apiFetch(`/api/v1/center/activity?${params.toString()}`);
}

// --- User Role Assignment (merged into Users page) ---

export async function assignUserRoles(userId: string, roleIds: string[]): Promise<void> {
  return apiFetch(`/api/v1/users/${userId}/roles`, {
    method: "POST",
    body: JSON.stringify({ role_ids: roleIds }),
  });
}

export async function removeUserRole(userId: string, roleId: string): Promise<void> {
  return apiFetch(`/api/v1/users/${userId}/roles/${roleId}`, {
    method: "DELETE",
  });
}
