import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Camera, CheckCircle2 } from "lucide-react";
import { Html5Qrcode } from "html5-qrcode";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type SerialNumberInputProps = {
  value: string;
  onChange: (value: string) => void;
  onScanned?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
};

export function SerialNumberInput({
  value,
  onChange,
  onScanned,
  placeholder = "Scan the QR code sticker or enter serial number",
  disabled = false,
  className,
}: SerialNumberInputProps) {
  const generatedId = useId();
  const scannerElementId = useMemo(
    () => `serial-qr-${generatedId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [generatedId],
  );
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const successTimerRef = useRef<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string>("");
  const [scanSuccess, setScanSuccess] = useState(false);

  const stopScanner = async () => {
    if (!scannerRef.current) return;
    try {
      if (scannerRef.current.isScanning) {
        await scannerRef.current.stop();
      }
    } catch {
      // Best effort cleanup.
    }
    try {
      await scannerRef.current.clear();
    } catch {
      // Ignore clear failures after stop.
    }
    scannerRef.current = null;
  };

  useEffect(() => {
    return () => {
      if (successTimerRef.current) window.clearTimeout(successTimerRef.current);
      void stopScanner();
    };
  }, []);

  const handleScannedValue = (decodedText: string) => {
    let nextValue = decodedText.trim();
    // If the QR code scanned is a URL, extract the serial number parameter or final path segment
    if (nextValue.startsWith("http://") || nextValue.startsWith("https://")) {
      try {
        const urlObj = new URL(nextValue);
        const serialParam = urlObj.searchParams.get("serial") || urlObj.searchParams.get("s");
        if (serialParam) {
          nextValue = serialParam.trim();
        } else {
          const parts = urlObj.pathname.split("/").filter(Boolean);
          if (parts.length > 0) {
            nextValue = parts[parts.length - 1].trim();
          }
        }
      } catch {
        // Fall back to raw string if parsing fails
      }
    }
    onChange(nextValue);
    onScanned?.(nextValue);
    setScanError("");
    setScanSuccess(true);
    if (successTimerRef.current) window.clearTimeout(successTimerRef.current);
    successTimerRef.current = window.setTimeout(() => setScanSuccess(false), 2000);
  };

  const startScanner = async () => {
    if (disabled || scanning) return;
    setScanError("");

    const isSecureOrigin =
      typeof window !== "undefined" &&
      (window.location.protocol === "https:" || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

    if (!isSecureOrigin) {
      setScanError(
        "Camera access requires a secure connection (HTTPS). Please open https://maheshfoundation-medical.com in your mobile browser.",
      );
      return;
    }

    setScanning(true);
    try {
      // Request camera permission upfront so device labels and stream permissions are granted
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
          stream.getTracks().forEach((track) => track.stop());
        } catch {
          // If environment facingMode fails, try generic video constraint
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true });
            stream.getTracks().forEach((track) => track.stop());
          } catch (permErr) {
            console.warn("Camera permission prompt denied or failed:", permErr);
          }
        }
      }

      const scanner = new Html5Qrcode(scannerElementId);
      scannerRef.current = scanner;

      const qrConfig = { fps: 10, qrbox: { width: 250, height: 250 } };
      const onScanSuccess = async (decodedText: string) => {
        handleScannedValue(decodedText);
        setScanning(false);
        await stopScanner();
      };

      try {
        await scanner.start({ facingMode: "environment" }, qrConfig, onScanSuccess, () => undefined);
      } catch {
        const devices = await Html5Qrcode.getCameras();
        if (devices && devices.length > 0) {
          const rearCamera =
            devices.find(
              (d) =>
                d.label.toLowerCase().includes("back") ||
                d.label.toLowerCase().includes("rear") ||
                d.label.toLowerCase().includes("environment") ||
                d.label.toLowerCase().includes("0"),
            ) || devices[0];

          await scanner.start(rearCamera.id, qrConfig, onScanSuccess, () => undefined);
        } else {
          // Fallback to user facing camera or default
          await scanner.start({ facingMode: "user" }, qrConfig, onScanSuccess, () => undefined);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (message.includes("permission") || message.includes("notallowed") || message.includes("denied")) {
        setScanError("Camera permission denied. Please tap the lock icon in your browser address bar and allow Camera access.");
      } else {
        setScanError("Could not start camera scanner. Ensure you are using HTTPS (https://maheshfoundation-medical.com) and camera permission is allowed.");
      }
      setScanning(false);
      await stopScanner();
    }
  };

  const cancelScanner = async () => {
    setScanning(false);
    setScanError("");
    await stopScanner();
  };

  return (
    <div className={cn("space-y-2.5", className)}>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            className={cn("pr-9 transition-all", scanSuccess && "border-success ring-1 ring-success/30")}
          />
          {scanSuccess && (
            <CheckCircle2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-success animate-in fade-in zoom-in" />
          )}
        </div>
        <Button
          type="button"
          variant={scanning ? "secondary" : "outline"}
          onClick={() => void (scanning ? cancelScanner() : startScanner())}
          disabled={disabled}
          className="shrink-0"
        >
          <Camera className="h-4 w-4 sm:mr-1.5" />
          <span className="hidden sm:inline">{scanning ? "Cancel" : "Scan QR"}</span>
          <span className="sm:hidden">{scanning ? "Cancel" : "Scan"}</span>
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Scan the QR code sticker on the device, or enter the serial number manually.
      </p>

      {scanning && (
        <div className="rounded-xl border border-primary/20 bg-card p-4 shadow-lg space-y-3 animate-in fade-in slide-in-from-top-2">
          <div className="relative mx-auto w-full max-w-[280px] overflow-hidden rounded-xl bg-black shadow-inner">
            <div
              id={scannerElementId}
              className="w-full h-full min-h-[220px]"
            />
          </div>
          <div className="flex items-center justify-center gap-2 text-xs font-medium text-muted-foreground">
            <Camera className="h-3.5 w-3.5 animate-pulse text-primary" />
            <span>Point camera directly at the QR sticker</span>
          </div>
          <div className="flex justify-center pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => void cancelScanner()}>
              Stop Camera
            </Button>
          </div>
        </div>
      )}

      {scanError && <p className="text-xs font-medium text-destructive animate-in fade-in">{scanError}</p>}
    </div>
  );
}
