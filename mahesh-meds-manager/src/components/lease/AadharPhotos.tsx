import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError, getAadharPhoto } from "@/lib/api";

export type AadharPhotosStatus = "present" | "deleted" | "none";

type Props = {
  requestId: string;
  status: AadharPhotosStatus;
  /** One photo serves both when the requester is the patient. */
  patientIsRequester: boolean;
};

type Loaded = { url: string } | { error: string } | null;

function AadharPhoto({ requestId, whose, title }: { requestId: string; whose: "requester" | "patient"; title: string }) {
  const [photo, setPhoto] = useState<Loaded>(null);
  const [open, setOpen] = useState(false);

  // Loaded once per page view (each load is recorded in the audit log) and kept only in memory.
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    getAadharPhoto(requestId, whose)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setPhoto({ url });
      })
      .catch((e) => {
        if (cancelled) return;
        setPhoto({ error: e instanceof ApiError && e.message ? e.message : "The photo could not be loaded" });
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [requestId, whose]);

  return (
    <div className="space-y-1.5">
      <p className="text-sm text-muted-foreground">{title}</p>
      {photo === null && <div className="h-36 w-full max-w-64 rounded-md border bg-muted animate-pulse" />}
      {photo && "error" in photo && (
        <div className="flex h-36 w-full max-w-64 items-center justify-center gap-2 rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground">
          <ImageOff className="h-4 w-4 shrink-0" /> {photo.error}
        </div>
      )}
      {photo && "url" in photo && (
        <>
          <button
            type="button"
            className="block rounded-md border overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setOpen(true)}
            aria-label={`Enlarge ${title}`}
          >
            <img src={photo.url} alt={title} className="h-36 w-full max-w-64 object-contain bg-muted" />
          </button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="max-w-3xl">
              <DialogHeader>
                <DialogTitle>{title}</DialogTitle>
              </DialogHeader>
              <img src={photo.url} alt={title} className="max-h-[75vh] w-full object-contain" />
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}

/** The Aadhaar card photos of a request, for reviewers. */
export function AadharPhotos({ requestId, status, patientIsRequester }: Props) {
  if (status === "none") {
    return <p className="text-sm text-muted-foreground">No Aadhaar photos (submitted before photos were required).</p>;
  }
  if (status === "deleted") {
    return <p className="text-sm text-muted-foreground">The Aadhaar photos were deleted after the retention period.</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <AadharPhoto
        requestId={requestId}
        whose="requester"
        title={patientIsRequester ? "Requester's Aadhaar card (also the patient)" : "Requester's Aadhaar card"}
      />
      {!patientIsRequester && <AadharPhoto requestId={requestId} whose="patient" title="Patient's Aadhaar card" />}
    </div>
  );
}
