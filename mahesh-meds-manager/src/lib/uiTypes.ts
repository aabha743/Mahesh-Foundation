export type AssetStatus = "Available" | "Leased" | "Under Repair" | "Retired";
export type LeaseStatus = "Pending" | "Approved" | "Rejected" | "Active" | "Closed";

export type AssetView = {
  id: string;
  serialNumber: string;
  skuName: string;
  assignedCenter: string;
  homeCenter: string;
  status: AssetStatus;
  warrantyExpiry: string;
  purchaseDate: string;
  notes: string;
};

export type LeaseRequestView = {
  id: string;
  token: string;
  requestorName: string;
  mobile: string;
  skus: string[];
  preferredCenter: string;
  status: LeaseStatus;
  submittedDate: string;
  issueDate?: string;
  returnDate?: string;
  actualReturnDate?: string;
};

export const assetStatusOptions: AssetStatus[] = ["Available", "Leased", "Under Repair", "Retired"];

export function maskMobile(mobile: string): string {
  return mobile.slice(0, 5) + "XXXXX";
}
