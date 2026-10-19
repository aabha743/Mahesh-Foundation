import { describe, expect, it } from "vitest";

import { dataUrlBytes, scaledSize } from "./photoUpload";

describe("scaledSize", () => {
  it("shrinks the longest side to the limit and keeps the shape", () => {
    expect(scaledSize(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(scaledSize(3000, 4000)).toEqual({ width: 1200, height: 1600 });
    expect(scaledSize(4032, 1960, 1200)).toEqual({ width: 1200, height: 583 });
  });

  it("never enlarges a small photo", () => {
    expect(scaledSize(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

describe("dataUrlBytes", () => {
  it("counts the decoded bytes of a base64 data URL", () => {
    expect(dataUrlBytes(`data:image/jpeg;base64,${btoa("abc")}`)).toBe(3);
    expect(dataUrlBytes(`data:image/jpeg;base64,${btoa("abcd")}`)).toBe(4);
    expect(dataUrlBytes(`data:image/jpeg;base64,${btoa("abcde")}`)).toBe(5);
  });
});
