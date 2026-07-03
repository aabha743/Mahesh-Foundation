import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Formats lease status from API response to user-friendly display text.
 * Maps backend API status values to consistent frontend display labels.
 */
export function formatLeaseStatus(status: string): string {
  const statusMap: Record<string, string> = {
    "closed": "Closed",
    "active": "Active", 
    "approved": "Approved",
    "pending": "Pending",
    "rejected": "Rejected",
  };
  
  return statusMap[status] || status;
}
