import { describe, expect, it } from "vitest";
import {
  type AuditLogRow,
  buildStaffLookup,
  deriveMilestones,
  emptyStaffLookup,
  formatActorFromLog,
  formatActorRoleSuffix,
  humanizeAuditAction,
  parseDurationDays,
  summarizeDuration,
  timelineDescription,
} from "./leaseTimeline";

function log(action: string, at: string, values: Partial<AuditLogRow> = {}): AuditLogRow {
  return {
    id: `${action}-${at}`,
    user_id: null,
    center_id: null,
    action,
    entity_type: "lease_request",
    entity_id: "lease-1",
    old_value: null,
    new_value: null,
    ip_address: null,
    created_at: at,
    ...values,
  };
}

const staff = buildStaffLookup([
  { id: "u1", name: "Asha (approver)", mobile: "+91 98765 43210" },
  { id: "u2", name: "Ravi (center)", mobile: "9000000002" },
]);

describe("buildStaffLookup", () => {
  it("indexes names by user id and by the last 10 digits of the mobile", () => {
    expect(staff.nameByUserId.u1).toBe("Asha (approver)");
    expect(staff.nameByMobile["9876543210"]).toBe("Asha (approver)");
  });
});

describe("deriveMilestones", () => {
  it("reads approval, issue and closing from the log", () => {
    const rows = [
      log("approve_request", "2026-10-01T10:00:00Z", { user_id: "u1" }),
      log("request_updated", "2026-10-02T10:00:00Z", {
        user_id: "u2",
        old_value: { status: "approved" },
        new_value: { status: "issued" },
      }),
      log("devices_returned", "2026-10-05T10:00:00Z", {
        user_id: "u2",
        old_value: { status: "issued" },
        new_value: { status: "partially_returned", still_out: 1 },
      }),
      log("devices_returned", "2026-10-08T10:00:00Z", {
        user_id: "u2",
        old_value: { status: "partially_returned" },
        new_value: { status: "returned", still_out: 0 },
      }),
    ];

    const m = deriveMilestones(rows, staff);

    expect(m.approvedAt).toBe("2026-10-01T10:00:00Z");
    expect(m.approvedBy).toBe("Asha (approver)");
    expect(m.issuedAt).toBe("2026-10-02T10:00:00Z");
    expect(m.closedAt).toBe("2026-10-08T10:00:00Z");
    expect(m.closedBy).toBe("Ravi (center)");
  });

  it("still recognises a close recorded by the older return screen", () => {
    const rows = [
      log("request_updated", "2026-10-03T10:00:00Z", {
        old_value: { status: "issued" },
        new_value: { status: "returned", actor_mobile: "9000000002" },
      }),
    ];

    expect(deriveMilestones(rows, staff).closedBy).toBe("Ravi (center)");
  });
});

describe("timelineDescription", () => {
  it("summarises a partial return", () => {
    const row = log("devices_returned", "2026-10-05T10:00:00Z", {
      new_value: { devices: [{ serial_number: "A" }], condition: "Minor Damage", still_out: 1, notes: "scratch" },
    });

    expect(timelineDescription(row)).toBe("1 device returned (Minor Damage) · 1 still out · Notes: scratch");
  });

  it("shows a status change on a request update", () => {
    const row = log("request_updated", "2026-10-02T10:00:00Z", {
      old_value: { status: "approved" },
      new_value: { status: "issued" },
    });

    expect(timelineDescription(row)).toBe("Status: approved → issued");
  });

  it("shows which mobile a handover OTP went to", () => {
    const row = log("handover_otp_verified", "2026-10-02T10:00:00Z", { new_value: { sent_to: "ending 93" } });

    expect(humanizeAuditAction(row.action)).toBe("Recipient verified by OTP");
    expect(timelineDescription(row)).toBe("Mobile ending 93");
  });
});

describe("actors and labels", () => {
  it("names automated entries and hides their role suffix", () => {
    const row = log("request_expired", "2026-10-04T10:00:00Z", { new_value: { actor_role: "system: pickup window job" } });

    expect(formatActorFromLog(row, emptyStaffLookup)).toBe("System (pickup window job)");
    expect(formatActorRoleSuffix(row)).toBe("");
  });

  it("labels known actions and falls back to the raw name", () => {
    expect(humanizeAuditAction("devices_returned")).toBe("Devices returned");
    expect(humanizeAuditAction("asset_ownership_updated")).toBe("asset ownership updated");
  });
});

describe("parseDurationDays", () => {
  it("understands weeks, months and days", () => {
    expect(parseDurationDays("2 Weeks")).toBe(14);
    expect(parseDurationDays("1 Month")).toBe(30);
    expect(parseDurationDays("10 days")).toBe(10);
    expect(parseDurationDays("")).toBeNull();
  });
});

describe("summarizeDuration", () => {
  const issuedAt = "2026-10-01T10:00:00Z";

  it("counts days on lease for a closed request", () => {
    const summary = summarizeDuration(
      { status: "closed", expected_duration: "1 Week", created_at: "2026-09-30T10:00:00Z" },
      { issuedAt, closedAt: "2026-10-06T09:00:00Z" },
    );

    expect(summary).toEqual({ kind: "closed", onLease: 5, expectedDays: 7 });
  });

  it("reports days left and overdue days for an active request", () => {
    const lease = { status: "active", expected_duration: "1 Week", created_at: "2026-09-30T10:00:00Z" };

    expect(summarizeDuration(lease, { issuedAt, closedAt: undefined }, new Date("2026-10-05T10:00:00Z"))).toMatchObject({
      kind: "active",
      daysLeft: 3,
    });
    expect(summarizeDuration(lease, { issuedAt, closedAt: undefined }, new Date("2026-10-10T10:00:00Z"))).toMatchObject({
      kind: "overdue",
      overdueDays: 2,
    });
  });
});
