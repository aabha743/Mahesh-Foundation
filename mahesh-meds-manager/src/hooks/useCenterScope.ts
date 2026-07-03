import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";

const STORAGE_KEY = "mahesh_center_id";
const CENTER_CHANGED_EVENT = "mahesh:center-changed";

export type CenterRow = {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
};

export function useCenterScope() {
  const { user, hasRole } = useAuth();
  const [centers, setCenters] = useState<CenterRow[]>([]);
  const [centerId, setCenterIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const list = await apiFetch<CenterRow[]>("/api/v1/centers");
        if (cancelled) return;
        let allowedCenterIds: Set<string> | null = null;
        if (hasRole("center_manager") || hasRole("asset_manager")) {
          if (user?.center_id) {
            allowedCenterIds = new Set([user.center_id]);
          } else {
            allowedCenterIds = new Set();
          }
        }
        const scopedCenters = allowedCenterIds ? list.filter((c) => allowedCenterIds!.has(c.id)) : list;
        setCenters(scopedCenters);
        const envId = import.meta.env.VITE_CENTER_ID as string | undefined;
        const stored = localStorage.getItem(STORAGE_KEY);
        let id = stored || envId || null;
        if (id && !scopedCenters.some((c) => c.id === id)) id = null;
        if (!id && scopedCenters.length) id = scopedCenters[0].id;
        setCenterIdState(id);
      } catch {
        if (!cancelled) {
          setCenters([]);
          setCenterIdState(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [hasRole, user?.center_id]);

  useEffect(() => {
    function handleCenterChanged(event: Event) {
      const customEvent = event as CustomEvent<string>;
      const id = customEvent.detail;
      if (id) setCenterIdState(id);
    }
    window.addEventListener(CENTER_CHANGED_EVENT, handleCenterChanged);
    return () => {
      window.removeEventListener(CENTER_CHANGED_EVENT, handleCenterChanged);
    };
  }, []);

  const setCenterId = useCallback((id: string) => {
    if (centers.length && !centers.some((c) => c.id === id)) return;
    localStorage.setItem(STORAGE_KEY, id);
    setCenterIdState(id);
    window.dispatchEvent(new CustomEvent<string>(CENTER_CHANGED_EVENT, { detail: id }));
  }, [centers]);

  const center = centers.find((c) => c.id === centerId) ?? null;

  return {
    centers,
    centerId,
    center,
    centerName: center?.name ?? "Center",
    setCenterId,
    loading,
  };
}
