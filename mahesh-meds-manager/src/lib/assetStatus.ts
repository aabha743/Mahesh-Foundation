import type { AssetStatus } from "@/lib/uiTypes";

export function dbAssetStatusToUi(status: string): AssetStatus {
  switch (status) {
    case "available":
      return "Available";
    case "leased":
      return "Leased";
    case "under_repair":
      return "Under Repair";
    case "retired":
      return "Retired";
    default:
      return "Available";
  }
}

export function uiAssetStatusToDb(status: AssetStatus): string {
  switch (status) {
    case "Available":
      return "available";
    case "Leased":
      return "leased";
    case "Under Repair":
      return "under_repair";
    case "Retired":
      return "retired";
    default:
      return "available";
  }
}
