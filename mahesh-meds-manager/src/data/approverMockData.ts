export interface ApprovalRequest {
  id: string;
  token: string;
  requestorName: string;
  mobile: string;
  aadhar: string;
  items: { sku: string; qty: number }[];
  preferredCenter: string;
  referredBy: string;
  submittedDate: string;
  daysWaiting: number;
  status: "Pending" | "Approved" | "Rejected" | "Active" | "Closed";
  reviewedDate?: string;
  rejectionReason?: string;
  notes?: string;
  expectedDuration?: string;
  availability?: Record<string, number>;
}

export const pendingRequests: ApprovalRequest[] = [
  { id: "p1", token: "MDF-A3X92K", requestorName: "Rajesh Kumar", mobile: "9876543210", aadhar: "XXXX-XXXX-3456", items: [{ sku: "Standard Wheelchair", qty: 1 }, { sku: "Walking Frame", qty: 1 }], preferredCenter: "Hyderabad Central", referredBy: "Dr. Suresh", submittedDate: "2025-03-28", daysWaiting: 7, status: "Pending", expectedDuration: "1 Month", availability: { "Standard Wheelchair": 18, "Walking Frame": 8 } },
  { id: "p2", token: "MDF-D9W15P", requestorName: "Sunita Devi", mobile: "9988776604", aadhar: "XXXX-XXXX-7891", items: [{ sku: "Nebulizer", qty: 1 }, { sku: "BP Monitor (Digital)", qty: 1 }], preferredCenter: "Hyderabad Central", referredBy: "Dr. Anita Reddy", submittedDate: "2025-03-25", daysWaiting: 10, status: "Pending", expectedDuration: "2 Weeks", availability: { "Nebulizer": 24, "BP Monitor (Digital)": 12 } },
  { id: "p3", token: "MDF-J3Q51V", requestorName: "Anitha Rani", mobile: "9988776610", aadhar: "XXXX-XXXX-2345", items: [{ sku: "Electric Wheelchair", qty: 1 }], preferredCenter: "Hyderabad Central", referredBy: "Smt. Laxmi (Social Worker)", submittedDate: "2025-03-29", daysWaiting: 6, status: "Pending", expectedDuration: "3 Months", availability: { "Electric Wheelchair": 5 } },
  { id: "p4", token: "MDF-M1N83W", requestorName: "Ganesh Reddy", mobile: "9876501234", aadhar: "XXXX-XXXX-6789", items: [{ sku: "Oxygen Concentrator", qty: 1 }], preferredCenter: "Secunderabad", referredBy: "Dr. Ravi Shankar", submittedDate: "2025-04-01", daysWaiting: 3, status: "Pending", expectedDuration: "1 Month", availability: { "Oxygen Concentrator": 14 } },
  { id: "p5", token: "MDF-N7O42X", requestorName: "Padma Lakshmi", mobile: "9876509876", aadhar: "XXXX-XXXX-1122", items: [{ sku: "Hospital Bed", qty: 1 }, { sku: "Oxygen Concentrator", qty: 1 }], preferredCenter: "Warangal", referredBy: "Dr. Priya Kumari", submittedDate: "2025-04-02", daysWaiting: 2, status: "Pending", expectedDuration: "1 Month", availability: { "Hospital Bed": 3, "Oxygen Concentrator": 14 } },
  { id: "p6", token: "MDF-P3Q18Y", requestorName: "Ravi Teja", mobile: "9876554321", aadhar: "XXXX-XXXX-3344", items: [{ sku: "Crutches", qty: 1 }], preferredCenter: "Karimnagar", referredBy: "PHC Referral", submittedDate: "2025-04-03", daysWaiting: 1, status: "Pending", expectedDuration: "2 Weeks", availability: { "Crutches": 15 } },
  { id: "p7", token: "MDF-R9S65Z", requestorName: "Meena Kumari", mobile: "9876511111", aadhar: "XXXX-XXXX-5566", items: [{ sku: "Standard Wheelchair", qty: 1 }, { sku: "BP Monitor (Digital)", qty: 1 }], preferredCenter: "Secunderabad", referredBy: "Dr. Ravi Shankar", submittedDate: "2025-03-30", daysWaiting: 5, status: "Pending", expectedDuration: "1 Month", availability: { "Standard Wheelchair": 18, "BP Monitor (Digital)": 12 } },
  { id: "p8", token: "MDF-T2U97A", requestorName: "Balaji Naidu", mobile: "9876522222", aadhar: "XXXX-XXXX-7788", items: [{ sku: "Walking Frame", qty: 2 }], preferredCenter: "Hyderabad Central", referredBy: "Dr. Mahesh Patel", submittedDate: "2025-03-26", daysWaiting: 9, status: "Pending", expectedDuration: "3 Months", availability: { "Walking Frame": 8 } },
];

export const reviewedRequests: ApprovalRequest[] = [
  { id: "r1", token: "MDF-B7Y41M", requestorName: "Priya Sharma", mobile: "9988776602", aadhar: "XXXX-XXXX-4567", items: [{ sku: "Hospital Bed", qty: 1 }], preferredCenter: "Secunderabad", referredBy: "Dr. Ravi Shankar", submittedDate: "2025-03-20", daysWaiting: 0, status: "Approved", reviewedDate: "2025-03-22" },
  { id: "r2", token: "MDF-C2Z83N", requestorName: "Amit Patel", mobile: "9988776603", aadhar: "XXXX-XXXX-5678", items: [{ sku: "Oxygen Concentrator", qty: 1 }], preferredCenter: "Warangal", referredBy: "PHC Referral", submittedDate: "2025-03-18", daysWaiting: 0, status: "Rejected", reviewedDate: "2025-03-21", rejectionReason: "Duplicate request — patient already has an active lease for the same device at another center." },
  { id: "r3", token: "MDF-K7P84W", requestorName: "Sanjay Gupta", mobile: "9988776611", aadhar: "XXXX-XXXX-8901", items: [{ sku: "BP Monitor (Digital)", qty: 1 }, { sku: "Nebulizer", qty: 1 }], preferredCenter: "Secunderabad", referredBy: "Dr. Anita Reddy", submittedDate: "2025-03-22", daysWaiting: 0, status: "Approved", reviewedDate: "2025-03-24" },
  { id: "r4", token: "MDF-L2O16X", requestorName: "Fatima Begum", mobile: "9988776612", aadhar: "XXXX-XXXX-2109", items: [{ sku: "Oxygen Concentrator", qty: 1 }], preferredCenter: "Warangal", referredBy: "Smt. Kavitha (ANM)", submittedDate: "2025-03-19", daysWaiting: 0, status: "Rejected", reviewedDate: "2025-03-23", rejectionReason: "Insufficient documentation provided. Patient needs to submit valid prescription from a registered medical practitioner." },
  { id: "r5", token: "MDF-E5V62Q", requestorName: "Mohammed Ali", mobile: "9988776605", aadhar: "XXXX-XXXX-3210", items: [{ sku: "Crutches", qty: 1 }], preferredCenter: "Karimnagar", referredBy: "Dr. Suresh Babu", submittedDate: "2025-03-15", daysWaiting: 0, status: "Approved", reviewedDate: "2025-03-17" },
];

export function maskMobileApprover(mobile: string): string {
  return mobile.slice(0, 2) + "XXXXX" + mobile.slice(7);
}

// Status tracking mock data for public pages
export interface StatusResult {
  token: string;
  status: "Pending" | "Approved" | "Rejected" | "Active" | "Closed";
  requestorName: string;
  mobile: string;
  items: { sku: string; qty: number; serial?: string }[];
  preferredCenter: string;
  centerAddress?: string;
  centerPhone?: string;
  submittedDate: string;
  rejectionReason?: string;
  issueDate?: string;
  returnDate?: string;
  actualReturnDate?: string;
  duration?: string;
}

export const statusLookup: Record<string, StatusResult> = {
  "MDF-A3X92K": { token: "MDF-A3X92K", status: "Pending", requestorName: "Rajesh Kumar", mobile: "98XXXXX210", items: [{ sku: "Standard Wheelchair", qty: 1 }, { sku: "Walking Frame", qty: 1 }], preferredCenter: "Hyderabad Central", submittedDate: "2025-03-28" },
  "MDF-B7Y41M": { token: "MDF-B7Y41M", status: "Approved", requestorName: "Priya Sharma", mobile: "99XXXXX602", items: [{ sku: "Hospital Bed", qty: 1 }], preferredCenter: "Secunderabad", centerAddress: "10-2-45, MG Road, Secunderabad - 500003", centerPhone: "9876543211", submittedDate: "2025-03-20" },
  "MDF-C2Z83N": { token: "MDF-C2Z83N", status: "Rejected", requestorName: "Amit Patel", mobile: "99XXXXX603", items: [{ sku: "Oxygen Concentrator", qty: 1 }], preferredCenter: "Warangal", submittedDate: "2025-03-18", rejectionReason: "Duplicate request — patient already has an active lease for the same device at another center." },
  "MDF-E5V62Q": { token: "MDF-E5V62Q", status: "Active", requestorName: "Mohammed Ali", mobile: "99XXXXX605", items: [{ sku: "Crutches", qty: 1, serial: "MHF-CR-001" }], preferredCenter: "Karimnagar", submittedDate: "2025-03-15", issueDate: "2025-03-17", returnDate: "2025-04-17" },
  "MDF-H4S78T": { token: "MDF-H4S78T", status: "Closed", requestorName: "Deepa Nair", mobile: "99XXXXX608", items: [{ sku: "Standard Wheelchair", qty: 1, serial: "MHF-WC-005" }], preferredCenter: "Warangal", submittedDate: "2025-02-10", issueDate: "2025-02-12", returnDate: "2025-03-12", actualReturnDate: "2025-03-10", duration: "26 days" },
};
