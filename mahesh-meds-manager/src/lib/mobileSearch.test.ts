import { describe, expect, it } from "vitest";

import { mobileFromSearch } from "./mobileSearch";

describe("mobileFromSearch", () => {
  it("reads mobile numbers in the usual Indian formats", () => {
    expect(mobileFromSearch("9876543210")).toBe("9876543210");
    expect(mobileFromSearch(" +91 98765 43210 ")).toBe("9876543210");
    expect(mobileFromSearch("919876543210")).toBe("9876543210");
    expect(mobileFromSearch("09876543210")).toBe("9876543210");
    expect(mobileFromSearch("98765-43210")).toBe("9876543210");
  });

  it("flags numbers that are not a 10-digit mobile", () => {
    expect(mobileFromSearch("12345")).toBe("");
    expect(mobileFromSearch("98765432101234")).toBe("");
  });

  it("treats anything with letters as a token", () => {
    expect(mobileFromSearch("MF-OCT-0001")).toBeNull();
    expect(mobileFromSearch("mf-oct-0001")).toBeNull();
  });
});
