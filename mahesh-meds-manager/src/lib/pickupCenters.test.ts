import { describe, expect, it } from "vitest";

import { centersWithStock, defaultPickupCenter, type StockRow } from "./pickupCenters";

const stock: StockRow[] = [
  { sku_id: "wheelchair", center_id: "hyd", available_count: 1 },
  { sku_id: "wheelchair", center_id: "sec", available_count: 3 },
  { sku_id: "walker", center_id: "sec", available_count: 2 },
  { sku_id: "walker", center_id: "hyd", available_count: 0 },
  { sku_id: "bed", center_id: "hyd", available_count: 2 },
];

describe("centersWithStock", () => {
  it("lists only centers with a free unit, most units first", () => {
    expect(centersWithStock("wheelchair", stock)).toEqual(["sec", "hyd"]);
    expect(centersWithStock("walker", stock)).toEqual(["sec"]);
    expect(centersWithStock("oxygen", stock)).toEqual([]);
  });
});

describe("defaultPickupCenter", () => {
  it("uses the only center that has the device", () => {
    expect(defaultPickupCenter("walker", stock, ["hyd"], "hyd")).toBe("sec");
    expect(defaultPickupCenter("oxygen", stock, [], null)).toBeNull();
  });

  it("keeps the person to one trip when the other devices already share a center", () => {
    expect(defaultPickupCenter("wheelchair", stock, ["hyd"], null)).toBe("hyd");
    expect(defaultPickupCenter("wheelchair", stock, ["sec", "hyd", "hyd"], "sec")).toBe("hyd");
  });

  it("then follows the area filter, then the center with the most units", () => {
    expect(defaultPickupCenter("wheelchair", stock, [], "hyd")).toBe("hyd");
    expect(defaultPickupCenter("wheelchair", stock, ["elsewhere"], null)).toBe("sec");
  });
});
