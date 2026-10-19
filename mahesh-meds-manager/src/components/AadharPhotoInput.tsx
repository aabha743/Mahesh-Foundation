import { useRef, useState } from "react";
import { Camera, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { preparePhoto } from "@/lib/photoUpload";

type Props = {
  id: string;
  /** What the photo is of, e.g. "requester's Aadhaar card". */
  subject: string;
  /** The prepared photo as a JPEG data: URL, or null. */
  value: string | null;
  onChange: (value: string | null) => void;
  error?: string;
};

/** Take or choose a photo of an Aadhaar card; it is shrunk in the browser and shown as a preview. */
export function AadharPhotoInput({ id, subject, value, onChange, error }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setProblem("");
    try {
      onChange(await preparePhoto(file));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "This photo could not be used. Please try another.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept="image/*"
        className="sr-only"
        aria-label={`Photo of the ${subject}`}
        onChange={(e) => void handleFile(e.target.files?.[0])}
      />
      {value ? (
        <div className="flex items-center gap-3 rounded-md border border-input p-2">
          <img src={value} alt={`Photo of the ${subject}`} className="h-20 w-32 shrink-0 rounded object-cover bg-muted" />
          <div className="flex flex-1 flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
              <RefreshCw className="h-4 w-4 mr-1" /> Change photo
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)} disabled={busy}>
              <X className="h-4 w-4 mr-1" /> Remove
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-11 w-full justify-start whitespace-normal border-dashed py-2 text-left"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          aria-label={`Take or choose a photo of the ${subject}`}
        >
          <Camera className="h-5 w-5 mr-2 shrink-0" />
          {busy ? "Preparing photo..." : "Take or choose a photo"}
        </Button>
      )}
      {(problem || error) && <p className="text-xs text-destructive">{problem || error}</p>}
    </div>
  );
}
