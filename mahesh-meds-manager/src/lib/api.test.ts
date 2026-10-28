import { describe, expect, it } from "vitest";

import { LEASE_PAGE_SIZE, leaseRequestCountsUrl, leaseRequestsUrl } from "./api";

describe("leaseRequestsUrl", () => {
  it("asks for every status with no filters", () => {
    expect(leaseRequestsUrl()).toBe("/api/v1/lease-requests");
    expect(leaseRequestsUrl({})).toBe("/api/v1/lease-requests");
  });

  it("sends one status, or several as a comma list", () => {
    expect(leaseRequestsUrl({ status: "active", limit: 3 })).toBe("/api/v1/lease-requests?status=active&limit=3");
    expect(leaseRequestsUrl({ status: ["approved", "active", "closed", "expired", "rejected"] })).toBe(
      "/api/v1/lease-requests?status=approved,active,closed,expired,rejected",
    );
    expect(leaseRequestsUrl({ status: [] })).toBe("/api/v1/lease-requests");
  });

  it("adds the center and the page", () => {
    expect(leaseRequestsUrl({ centerId: "c 1", status: "approved", limit: 200 })).toBe(
      "/api/v1/lease-requests?status=approved&center_id=c%201&limit=200",
    );
    expect(leaseRequestsUrl({ limit: LEASE_PAGE_SIZE, offset: 100 })).toBe("/api/v1/lease-requests?limit=50&offset=100");
  });

  it("leaves out an empty center and the first page's offset", () => {
    expect(leaseRequestsUrl({ centerId: null, limit: 8, offset: 0 })).toBe("/api/v1/lease-requests?limit=8");
    expect(leaseRequestsUrl({ centerId: "", status: undefined })).toBe("/api/v1/lease-requests");
  });
});

describe("leaseRequestCountsUrl", () => {
  it("counts every request, or one center's", () => {
    expect(leaseRequestCountsUrl()).toBe("/api/v1/lease-requests/counts");
    expect(leaseRequestCountsUrl(null)).toBe("/api/v1/lease-requests/counts");
    expect(leaseRequestCountsUrl("hyd")).toBe("/api/v1/lease-requests/counts?center_id=hyd");
  });
});
