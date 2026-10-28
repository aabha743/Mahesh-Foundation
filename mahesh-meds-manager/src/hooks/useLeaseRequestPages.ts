import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  apiFetch,
  fetchLeaseRequestCounts,
  LEASE_PAGE_SIZE,
  leaseRequestsUrl,
  type LeaseRequestCounts,
  type LeaseRequestListQuery,
} from "@/lib/api";

/**
 * A staff list of lease requests, filtered and paged on the server. The first page loads whenever the
 * filters change; `loadMore` appends the next page and `reload` fetches the first page again (e.g. after
 * an approve or reject). Pass null to wait, e.g. until the center is known. Answers that arrive after the
 * filters changed again are dropped.
 */
export function useLeaseRequestPages<T extends { id: string }>(
  query: Pick<LeaseRequestListQuery, "status" | "centerId"> | null,
  errorMessage: string,
) {
  // The filters as a URL, so a new query object with the same filters does not reload the list.
  const firstPageUrl = query ? leaseRequestsUrl({ ...query, limit: LEASE_PAGE_SIZE }) : null;
  const [rows, setRows] = useState<T[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(firstPageUrl !== null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Bumped by every first-page load, so a late page for older filters is ignored.
  const generation = useRef(0);

  const reload = useCallback(async () => {
    if (!firstPageUrl) return;
    const current = ++generation.current;
    setLoading(true);
    setLoadingMore(false);
    try {
      const page = await apiFetch<T[]>(firstPageUrl);
      if (current !== generation.current) return;
      setRows(page);
      setHasMore(page.length === LEASE_PAGE_SIZE);
    } catch {
      if (current === generation.current) toast.error(errorMessage);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [firstPageUrl, errorMessage]);

  useEffect(() => {
    // New filters: drop the previous tab's rows rather than show them under the new one.
    setRows([]);
    setHasMore(false);
    void reload();
  }, [reload]);

  const loadMore = async () => {
    if (!query || loadingMore) return;
    const current = generation.current;
    setLoadingMore(true);
    try {
      const page = await apiFetch<T[]>(leaseRequestsUrl({ ...query, limit: LEASE_PAGE_SIZE, offset: rows.length }));
      if (current !== generation.current) return;
      // A request added since the first page shifts the pages by one; skip the repeat.
      setRows((prev) => {
        const seen = new Set(prev.map((row) => row.id));
        return [...prev, ...page.filter((row) => !seen.has(row.id))];
      });
      setHasMore(page.length === LEASE_PAGE_SIZE);
    } catch {
      if (current === generation.current) toast.error(errorMessage);
    } finally {
      if (current === generation.current) setLoadingMore(false);
    }
  };

  return { rows, hasMore, loading, loadingMore, loadMore, reload };
}

/**
 * Tab counts for the staff lease request lists (one center's when `centerId` is given); null until loaded.
 * Pass `enabled` false to wait, e.g. until the center is known.
 */
export function useLeaseRequestCounts(centerId?: string | null, enabled = true) {
  const [counts, setCounts] = useState<LeaseRequestCounts | null>(null);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    if (!enabled) return;
    const current = ++generation.current;
    try {
      const next = await fetchLeaseRequestCounts(centerId);
      if (current === generation.current) setCounts(next);
    } catch {
      // The lists still work without their tab counts.
    }
  }, [centerId, enabled]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { counts, reload };
}
