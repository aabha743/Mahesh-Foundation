/**
 * Turning a request's activity-log entries into what the Lease Requests token dialog shows:
 * milestones, timeline rows, who acted, and how long the devices have been out.
 */
import { formatLeaseStatus } from "@/lib/utils";
import type { LeaseStatus } from "@/lib/uiTypes";

export type AuditLogRow = {
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
  center_name?: string | null;
};

export type StaffLookup = {
  nameByUserId: Record<string, string>;
  nameByMobile: Record<string, string>;
};

export const emptyStaffLookup: StaffLookup = { nameByUserId: {}, nameByMobile: {} };

export function normalizeMobile(m: string): string {
  return m.replace(/\D/g, "").slice(-10) || m;
}

/** Staff names by user id and by 10-digit mobile, for naming the actor of a log entry. */
export function buildStaffLookup(users: Array<{ id: string; name: string; mobile: string }>): StaffLookup {
  const nameByUserId: Record<string, string> = {};
  const nameByMobile: Record<string, string> = {};
  for (const u of users) {
    nameByUserId[u.id] = u.name;
    const key = normalizeMobile(u.mobile);
    if (key.length === 10) nameByMobile[key] = u.name;
  }
  return { nameByUserId, nameByMobile };
}

export function parseDurationDays(expected: string | null | undefined): number | null {
  if (!expected?.trim()) return null;
  const lower = expected.trim().toLowerCase();
  const num = parseInt(lower.match(/\d+/)?.[0] ?? "", 10);
  if (!Number.isFinite(num)) return null;
  if (lower.includes("week")) return num * 7;
  if (lower.includes("month")) return num * 30;
  if (lower.includes("day")) return num;
  return num;
}

function strField(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function formatDateOnly(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso.slice(0, 10);
  }
}

export function daysBetween(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

/** Automated entries record actor_role as "system: <job>" or "ops: <what was done>". */
function automatedActor(log: AuditLogRow): string | null {
  const role = typeof log.new_value?.actor_role === "string" ? log.new_value.actor_role.trim() : "";
  const match = /^(system|ops):\s*(.+)$/i.exec(role);
  if (!match) return null;
  const kind = match[1].toLowerCase() === "ops" ? "Ops" : "System";
  return `${kind} (${match[2]})`;
}

/** Resolves audit actor for display (handles legacy `actor_mobile: "public"` from older API logs). */
export function formatActorFromLog(log: AuditLogRow, staff: StaffLookup): string {
  const named = log.user_name?.trim();
  if (named) return named;
  const automated = automatedActor(log);
  if (automated) return automated;
  const uid = log.user_id;
  if (uid && staff.nameByUserId[uid]) return staff.nameByUserId[uid];
  const raw = log.new_value?.actor_mobile;
  const mobile = typeof raw === "string" ? raw.trim() : "";
  if (mobile && /^\d{10}$/.test(mobile)) {
    return staff.nameByMobile[mobile] ?? mobile;
  }
  if (!mobile || mobile.toLowerCase() === "public") {
    const role = typeof log.new_value?.actor_role === "string" ? log.new_value.actor_role.trim() : "";
    if (role && role.toLowerCase() !== "public") {
      const label = role.replace(/_/g, " ");
      return `Staff (${label}) — name not in log; stay logged in when acting`;
    }
    return "Not recorded — stay logged in on staff pages so actions are attributed to you";
  }
  return mobile;
}

export function formatActorRoleSuffix(log: AuditLogRow): string {
  const r = log.new_value?.actor_role;
  if (typeof r !== "string" || !r.trim()) return "";
  if (r.trim().toLowerCase() === "public") return "";
  if (automatedActor(log)) return "";
  return ` · ${r.replace(/_/g, " ")}`;
}

export function humanizeAuditAction(action: string): string {
  const labels: Record<string, string> = {
    request_created: "Request submitted (token issued)",
    approve_request: "Approved",
    reject_request: "Rejected",
    request_expired: "Expired (pickup window passed)",
    request_updated: "Request / fulfillment updated",
    devices_returned: "Devices returned",
    token_viewed: "Token looked up",
  };
  return labels[action] ?? action.replace(/_/g, " ");
}

/** Derives milestone timestamps from audit rows (sorted ascending). */
export function deriveMilestones(sortedAsc: AuditLogRow[], staff: StaffLookup) {
  let approvedAt: string | undefined;
  let approvedBy: string | undefined;
  let issuedAt: string | undefined;
  let issuedBy: string | undefined;
  let closedAt: string | undefined;
  let closedBy: string | undefined;
  let rejectedAt: string | undefined;
  let rejectedBy: string | undefined;

  for (const log of sortedAsc) {
    if (log.action === "approve_request") {
      approvedAt = log.created_at;
      approvedBy = formatActorFromLog(log, staff);
    }
    if (log.action === "reject_request") {
      rejectedAt = log.created_at;
      rejectedBy = formatActorFromLog(log, staff);
    }
    if (log.action === "request_updated") {
      const oldS = strField(log.old_value?.status);
      const newS = strField(log.new_value?.status);
      if ((newS === "issued" || newS === "partially_returned") && oldS !== "issued" && oldS !== "partially_returned") {
        if (!issuedAt) {
          issuedAt = log.created_at;
          issuedBy = formatActorFromLog(log, staff);
        }
      }
      if (newS === "returned" && oldS !== "returned") {
        closedAt = log.created_at;
        closedBy = formatActorFromLog(log, staff);
      }
    }
    if (log.action === "devices_returned" && strField(log.new_value?.status) === "returned") {
      closedAt = log.created_at;
      closedBy = formatActorFromLog(log, staff);
    }
  }

  return { approvedAt, approvedBy, issuedAt, issuedBy, closedAt, closedBy, rejectedAt, rejectedBy };
}

export type Milestones = ReturnType<typeof deriveMilestones>;

export function timelineDescription(log: AuditLogRow): string | null {
  const nv = log.new_value ?? {};
  const ov = log.old_value ?? {};
  if (log.action === "request_updated") {
    const oldS = strField(ov.status);
    const newS = strField(nv.status);
    if (oldS && newS && oldS !== newS) return `Status: ${oldS} → ${newS}`;
    const notes = strField(nv.notes);
    if (notes?.includes("[Approver Edit]")) return "Approver edited line items or notes";
    if (notes?.includes("fulfillment:")) return "Fulfillment / issue notes updated";
  }
  if (log.action === "approve_request") {
    const c = strField(nv.approval_comments);
    return c ? `Comments: ${c}` : null;
  }
  if (log.action === "devices_returned") {
    const count = Array.isArray(nv.devices) ? nv.devices.length : 0;
    const stillOut = typeof nv.still_out === "number" ? nv.still_out : 0;
    const condition = strField(nv.condition);
    const notes = strField(nv.notes);
    return [
      `${count} device${count === 1 ? "" : "s"} returned${condition ? ` (${condition})` : ""}`,
      stillOut > 0 ? `${stillOut} still out` : "all devices back",
      notes ? `Notes: ${notes}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (log.action === "reject_request") {
    const r = strField(nv.rejection_reason);
    return r ? `Reason recorded in log: ${r}` : null;
  }
  return null;
}

export const skipTimelineActions = new Set(["token_viewed", "requests_list_viewed"]);

/** Days on lease, days left or days overdue, from the request's status, expected duration and milestones. */
export function summarizeDuration(
  lease: { status: string; expected_duration: string | null; created_at: string },
  milestones: Pick<Milestones, "issuedAt" | "closedAt">,
  now: Date = new Date(),
) {
  const expectedDays = parseDurationDays(lease.expected_duration);
  const uiStatus = formatLeaseStatus(lease.status) as LeaseStatus;
  const issueDate = milestones.issuedAt ? new Date(milestones.issuedAt) : null;
  const closeDate = milestones.closedAt ? new Date(milestones.closedAt) : null;
  const submitted = new Date(lease.created_at);

  if (uiStatus === "Closed" && issueDate && closeDate) {
    const onLease = daysBetween(issueDate, closeDate);
    return { kind: "closed" as const, onLease, expectedDays };
  }
  if (uiStatus === "Active" && issueDate && expectedDays != null) {
    const due = new Date(issueDate);
    due.setDate(due.getDate() + expectedDays);
    if (due.getTime() < now.getTime()) {
      const overdue = daysBetween(due, now);
      return { kind: "overdue" as const, overdueDays: overdue, dueDate: due.toISOString(), expectedDays };
    }
    const left = daysBetween(now, due);
    return { kind: "active" as const, daysLeft: left, dueDate: due.toISOString(), expectedDays };
  }
  if (uiStatus === "Active" && issueDate && expectedDays == null) {
    return { kind: "active_no_due" as const, expectedLabel: lease.expected_duration };
  }
  if (uiStatus === "Closed" && closeDate && !issueDate) {
    const approx = daysBetween(submitted, closeDate);
    return { kind: "closed_approx" as const, approx };
  }
  return null;
}
