import { Printer } from "lucide-react";
import { AssetStickerLabel } from "@/components/assets/AssetStickerLabel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AssetView } from "@/lib/uiTypes";
import { printSticker } from "@/lib/printSticker";

type AssetQrDialogProps = {
  asset: AssetView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function AssetQrDialog({ asset, open, onOpenChange }: AssetQrDialogProps) {
  if (!asset) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-xl mx-4 md:mx-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{asset.skuName}</DialogTitle>
          <DialogDescription>
            Asset QR label for {asset.serialNumber}. Print this in the same 60x40mm sticker format used after asset creation.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-start">
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Serial number</p>
            <p className="font-mono text-2xl font-bold tracking-[0.16em] text-foreground">{asset.serialNumber}</p>
            <p className="text-sm text-muted-foreground">Current location</p>
            <p className="text-sm font-medium text-foreground">{asset.assignedCenter}</p>
          </div>

          <div className="mx-auto max-w-full overflow-hidden">
            <AssetStickerLabel
              serialNumber={asset.serialNumber}
              skuName={asset.skuName}
              centerName={asset.assignedCenter}
              className="shadow-sm"
            />
          </div>
        </div>

        <div className="flex justify-end">
          <Button className="w-full md:w-auto" onClick={() => printSticker({ serialNumber: asset.serialNumber, skuName: asset.skuName, centerName: asset.assignedCenter })}>
            <Printer className="mr-2 h-4 w-4" />
            Print sticker
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
