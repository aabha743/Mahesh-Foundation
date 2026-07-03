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
  const [isMobileCapable, setIsMobileCapable] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string>("");
  const [scanSuccess, setScanSuccess] = useState(false);

  useEffect(() => {
    const evaluateSupport = () => {
      setIsMobileCapable(
        typeof window !== "undefined" &&
          window.innerWidth <= 768 &&
          typeof navigator !== "undefined" &&
          !!navigator.mediaDevices?.getUserMedia,
      );
    };

    evaluateSupport();
    window.addEventListener("resize", evaluateSupport);
    return () => {
      window.removeEventListener("resize", evaluateSupport);
    };
  }, []);

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
    const nextValue = decodedText.trim();
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
    setScanning(true);

    try {
      const scanner = new Html5Qrcode(scannerElementId);
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async (decodedText) => {
          handleScannedValue(decodedText);
          setScanning(false);
          await stopScanner();
        },
        () => undefined,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (message.includes("permission") || message.includes("notallowed") || message.includes("denied")) {
        setScanError("Camera access denied. Please enter the serial number manually.");
      } else {
        setScanError("Could not start camera scanner. Please enter the serial number manually.");
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
        {isMobileCapable && (
          <Button type="button" variant="outline" onClick={() => void startScanner()} disabled={disabled || scanning}>
            <Camera className="mr-2 h-4 w-4" />
            Scan QR
          </Button>
        )}
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
