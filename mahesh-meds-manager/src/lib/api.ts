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

/** An API error with its HTTP status, so callers can tell e.g. "verify with OTP" (401) from other failures. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Global error handler for API responses.
 * - 401: User not authenticated, redirect to login (unless skipAuthRedirect is true);
 *   for public requests it means "verify with OTP" and is simply thrown
 * - 403: Permission denied, show error toast
 */
function handleApiError(response: Response, errorText: string, init?: ApiFetchOptions): never {
  if (response.status === 401) {
    if (init?.publicRequest) {
      throw new ApiError(401, errorText || "Please verify with the OTP first.");
    }
    // Only redirect if this isn't an auth check call
    // Auth check calls (like /me) should fail silently on 401
    if (!init?.skipAuthRedirect) {
      window.location.href = "/login";
    }
    throw new ApiError(401, "Session expired. Please log in again.");
  }

  if (response.status === 403) {
    toast.error("You don't have permission to perform this action");
    throw new ApiError(403, errorText || "Permission denied");
  }

  if (response.status >= 500) {
    toast.error("Something went wrong. Please try again.");
    throw new ApiError(response.status, errorText || "Server error");
  }

  throw new ApiError(response.status, errorText || `Request failed with status ${response.status}`);
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
  /** Public page call: a 401 means "verify with OTP", so no staff-session refresh or login redirect. */
  publicRequest?: boolean;
  /** Return the response body as a Blob (e.g. an image) instead of parsing JSON. */
  blob?: boolean;
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
  if (response.status === 401 && !path.includes("/auth/") && !init?.publicRequest) {
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
    handleApiError(response, errorText, init);
  }

  // Handle empty responses (e.g., 204 No Content)
  if (response.status === 204) {
    return undefined as T;
  }
  if (init?.blob) {
    return response.blob() as Promise<T>;
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

/** Name, mobile and Aadhaar come from the lease on the server (the mobile was verified by OTP). */
export interface LeaseExtensionCreatePayload {
  token_number: string;
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

/** Public lookups need a tracking session (OTP) unless staff are logged in; a 401 ApiError means "verify first". */
export async function getLeaseRequestByToken(token: string): Promise<LeaseRequestTokenLookup> {
  return apiFetch(`/api/v1/lease-requests/by-token/${encodeURIComponent(token)}`, { publicRequest: true });
}

export async function getLeaseRequestsByMobile(mobile: string): Promise<LeaseRequestTokenLookup[]> {
  return apiFetch(`/api/v1/lease-requests/by-mobile/${encodeURIComponent(mobile)}`, { publicRequest: true });
}

export async function createLeaseExtension(payload: LeaseExtensionCreatePayload): Promise<LeaseExtension> {
  return apiFetch("/api/v1/lease-extensions", {
    method: "POST",
    body: JSON.stringify(payload),
    publicRequest: true,
  });
}

export interface TrackOtpSent {
  sent_to: string; // e.g. "ending 10"
  expires_in: number;
  resend_in: number;
}

/** Text an OTP to the mobile on the request (token) or to the number entered. */
export async function sendTrackOtp(query: string): Promise<TrackOtpSent> {
  return apiFetch("/api/v1/track/send-otp", { method: "POST", body: JSON.stringify({ query }), publicRequest: true });
}

/** Check the OTP; on success the browser gets a 30-minute tracking session (HttpOnly cookie). */
export async function verifyTrackOtp(query: string, otp: string): Promise<{ verified: boolean; expires_in: number }> {
  return apiFetch("/api/v1/track/verify-otp", { method: "POST", body: JSON.stringify({ query, otp }), publicRequest: true });
}

export async function endTrackSession(): Promise<void> {
  await apiFetch("/api/v1/track/logout", { method: "POST", publicRequest: true });
}

/** True when an API call failed only because the browser has not verified the number by OTP yet. */
export function needsOtp(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** Device handover: text an OTP to the request's mobile, for the person collecting the devices to read out. */
export async function sendHandoverOtp(leaseId: string, centerId: string): Promise<TrackOtpSent> {
  return apiFetch(`/api/v1/lease-requests/${encodeURIComponent(leaseId)}/handover/send-otp`, {
    method: "POST",
    body: JSON.stringify({ center_id: centerId }),
  });
}

/** Check the code read out at the counter; if right, this user may issue devices for the request once, within 30 minutes. */
export async function verifyHandoverOtp(
  leaseId: string,
  centerId: string,
  otp: string,
): Promise<{ verified: boolean; expires_in: number }> {
  return apiFetch(`/api/v1/lease-requests/${encodeURIComponent(leaseId)}/handover/verify-otp`, {
    method: "POST",
    body: JSON.stringify({ center_id: centerId, otp }),
  });
}

/** An Aadhaar card photo of a request, for reviewers; every view is recorded. 410: deleted after the retention period. */
export async function getAadharPhoto(leaseId: string, whose: "requester" | "patient"): Promise<Blob> {
  return apiFetch(`/api/v1/lease-requests/${encodeURIComponent(leaseId)}/aadhar-photo/${whose}`, { blob: true });
}

/** True when an issue was refused because the requester's OTP has not been entered (or was already used / lapsed). */
export function needsHandoverOtp(error: unknown): boolean {
  return error instanceof ApiError && error.status === 428;
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

// --- Staff lease request lists (filtered and paged on the server) ---

/** Lease request statuses as the API spells them. */
export type LeaseRequestStatus = "pending" | "approved" | "rejected" | "expired" | "active" | "closed";

/** Rows per page on the staff lease request lists; "Show more" loads the next page. */
export const LEASE_PAGE_SIZE = 50;

export interface LeaseRequestListQuery {
  /** One status or several; none means every status. */
  status?: LeaseRequestStatus | readonly LeaseRequestStatus[];
  /** Only the requests this center works on (center managers always get their own center). */
  centerId?: string | null;
  /** 1..200; the server's default is 50. */
  limit?: number;
  offset?: number;
}

/** URL of one page of staff lease requests, newest first. */
export function leaseRequestsUrl({ status, centerId, limit, offset }: LeaseRequestListQuery = {}): string {
  const statuses: readonly LeaseRequestStatus[] = status === undefined ? [] : typeof status === "string" ? [status] : status;
  const params: string[] = [];
  if (statuses.length > 0) params.push(`status=${statuses.map(encodeURIComponent).join(",")}`);
  if (centerId) params.push(`center_id=${encodeURIComponent(centerId)}`);
  if (limit !== undefined) params.push(`limit=${limit}`);
  if (offset) params.push(`offset=${offset}`);
  return params.length > 0 ? `/api/v1/lease-requests?${params.join("&")}` : "/api/v1/lease-requests";
}

/** Tab counts for the staff lease request lists. */
export interface LeaseRequestCounts {
  total: number;
  by_status: Record<LeaseRequestStatus, number>;
  /** Active requests with a device whose home (or current) center is the center, by center id. */
  active_by_center: Record<string, number>;
}

export function leaseRequestCountsUrl(centerId?: string | null): string {
  return centerId
    ? `/api/v1/lease-requests/counts?center_id=${encodeURIComponent(centerId)}`
    : "/api/v1/lease-requests/counts";
}

export async function fetchLeaseRequestCounts(centerId?: string | null): Promise<LeaseRequestCounts> {
  return apiFetch(leaseRequestCountsUrl(centerId));
}

/** A device out on loan now (issued, not returned) and the request it is on. */
export interface LeaseOpenItem {
  asset_id: string;
  due_date: string | null;
  lease_request_id: string;
  token_number: string;
  requestor_name: string;
  mobile: string;
}

/** Devices out on loan whose home or current center is the center: for the center's inventory screen. */
export async function listLeaseOpenItems(centerId: string): Promise<LeaseOpenItem[]> {
  return apiFetch(`/api/v1/lease-requests/open-items?center_id=${encodeURIComponent(centerId)}`);
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
