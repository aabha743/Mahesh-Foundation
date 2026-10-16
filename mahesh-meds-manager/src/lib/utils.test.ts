import { describe, expect, it } from "vitest";

import { formatLeaseStatus, formatPickupCenterLabel } from "./utils";

describe("formatLeaseStatus", () => {
  it("labels every lease status the API returns", () => {
    expect(formatLeaseStatus("pending")).toBe("Pending");
    expect(formatLeaseStatus("approved")).toBe("Approved");
    expect(formatLeaseStatus("rejected")).toBe("Rejected");
    expect(formatLeaseStatus("active")).toBe("Active");
    expect(formatLeaseStatus("closed")).toBe("Closed");
    expect(formatLeaseStatus("expired")).toBe("Expired");
  });
});

describe("formatPickupCenterLabel", () => {
  it("prefers the pickup guidance centers when the API sends them", () => {
    expect(formatPickupCenterLabel("Approved", ["Hyderabad", "Secunderabad"], "Hyderabad")).toBe("Hyderabad, Secunderabad");
  });

  it("explains a missing plan for requests that still need stock", () => {
    expect(formatPickupCenterLabel("Pending", [], "Hyderabad")).toBe("Awaiting stock mapping");
    expect(formatPickupCenterLabel("Expired", [], "Hyderabad")).toBe("Stock released");
  });

  it("falls back to the chosen center for finished requests", () => {
    expect(formatPickupCenterLabel("Rejected", [], "Hyderabad")).toBe("Hyderabad");
    expect(formatPickupCenterLabel("Closed", [], undefined)).toBe("—");
  });
});
