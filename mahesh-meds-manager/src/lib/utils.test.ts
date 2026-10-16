import { describe, expect, it } from "vitest";

import { formatLeaseStatus } from "./utils";

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
