import type { MeResponse } from "@/lib/api";

export function getUserDisplayName(user: MeResponse | null, fallback: string): string {
  const name = user?.name?.trim();
  return name || fallback;
}

export function getUserInitials(user: MeResponse | null, fallback: string): string {
  const name = user?.name?.trim();
  if (!name) return fallback;

  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }

  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}
