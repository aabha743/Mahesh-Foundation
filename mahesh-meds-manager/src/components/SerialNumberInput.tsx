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

    const hasCameraSupport =
      typeof navigator !== "undefined" &&
      (!!navigator.mediaDevices?.getUserMedia ||
        !!(navigator as any).getUserMedia ||
        !!(navigator as any).webkitGetUserMedia ||
        !!(navigator as any).mozGetUserMedia);

    if (!isSecureOrigin || !hasCameraSupport) {
      setScanError(
        "Camera access requires HTTPS. Please access the website via https://maheshfoundation-medical.com to use the camera scanner.",
      );
      return;
    }

    setScanning(true);
    try {
      const scanner = new Html5Qrcode(scannerElementId);
      scannerRef.current = scanner;

      const qrConfig = { fps: 10, qrbox: { width: 250, height: 250 } };
      const onScanSuccess = async (decodedText: string) => {
        handleScannedValue(decodedText);
        setScanning(false);
        await stopScanner();
      };

      try {
        // First try rear camera by facingMode
        await scanner.start({ facingMode: "environment" }, qrConfig, onScanSuccess, () => undefined);
      } catch {
        // Fallback to camera enumeration
        const devices = await Html5Qrcode.getCameras();
        if (devices && devices.length > 0) {
          const rearCamera =
            devices.find(
              (d) => d.label.toLowerCase().includes("back") || d.label.toLowerCase().includes("rear") || d.label.toLowerCase().includes("environment"),
            ) || devices[0];

          await scanner.start(rearCamera.id, qrConfig, onScanSuccess, () => undefined);
        } else {
          throw new Error("No camera found on device");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (message.includes("permission") || message.includes("notallowed") || message.includes("denied")) {
        setScanError("Camera permission denied. Please allow camera permissions in browser settings.");
      } else {
        setScanError("Could not start camera scanner. Please enter the serial number manually or use HTTPS.");
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
    <div className={cn("space-y-2", className)}>
      <div className="flex gap-2 items-start">
        <div className="relative flex-1">
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            className={cn(scanSuccess && "border-success ring-1 ring-success/30")}
          />
          {scanSuccess && (
            <CheckCircle2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-success" />
          )}
        </div>
        <Button type="button" variant="outline" onClick={() => void startScanner()} disabled={disabled || scanning}>
          <Camera className="mr-2 h-4 w-4" />
          Scan QR
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Scan the QR code sticker on the device, or enter the serial number manually.
      </p>

      {scanning && (
        <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
          <div
            id={scannerElementId}
            className="mx-auto max-w-[280px] overflow-hidden rounded-lg border bg-black"
          />
          <p className="text-sm text-center text-muted-foreground">
            Point camera at the QR code on the asset
          </p>
          <div className="flex justify-center">
            <Button type="button" variant="outline" onClick={() => void cancelScanner()}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {scanError && <p className="text-xs text-destructive">{scanError}</p>}
    </div>
  );
}
