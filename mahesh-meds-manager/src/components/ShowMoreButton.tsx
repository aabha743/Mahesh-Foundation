import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  /** False once the last page came back short: the button is hidden. */
  hasMore: boolean;
  loading: boolean;
  onClick: () => void;
  className?: string;
};

/** "Show more" under a paged list: loads and appends the next page. */
export function ShowMoreButton({ hasMore, loading, onClick, className }: Props) {
  if (!hasMore) return null;
  return (
    <div className={cn("flex justify-center", className)}>
      <Button variant="outline" size="sm" onClick={onClick} disabled={loading}>
        {loading ? "Loading..." : "Show more"}
      </Button>
    </div>
  );
}
