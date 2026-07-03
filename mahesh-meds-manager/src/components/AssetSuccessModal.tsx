import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Printer, Plus, CheckCircle } from "lucide-react";
import { AssetStickerLabel } from "@/components/assets/AssetStickerLabel";
import { printSticker } from "@/lib/printSticker";

interface AssetSuccessModalProps {
  open: boolean;
  onClose: () => void;
  assetData: {
    serialNumber: string;
    skuName: string;
    centerName: string;
  } | null;
  onPrintSticker: () => void;
  onAddAnother: () => void;
}

export function AssetSuccessModal({ open, onClose, assetData, onPrintSticker, onAddAnother }: AssetSuccessModalProps) {
  if (!assetData) return null;

  const handlePrint = () => {
    printSticker(assetData);
    onPrintSticker();
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="w-full max-w-md mx-4 md:mx-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle className="h-5 w-5 text-success" />
            Asset Created Successfully
          </DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4">
          <div className="bg-muted/50 rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">SKU:</span>
              <Badge variant="outline">{assetData.skuName}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Serial Number:</span>
              <span className="font-mono font-bold">{assetData.serialNumber}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Center:</span>
              <span className="text-sm">{assetData.centerName}</span>
            </div>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <p className="text-sm text-blue-800">
              Print a sticker for this asset to attach to the physical device.
            </p>
          </div>

          <div className="flex justify-center rounded-lg border bg-muted/20 p-4">
            <AssetStickerLabel
              serialNumber={assetData.serialNumber}
              skuName={assetData.skuName}
              centerName={assetData.centerName}
              className="shadow-sm"
            />
          </div>

          <div className="flex flex-col md:flex-row gap-2 pt-2">
            <Button onClick={handlePrint} className="flex-1 w-full md:w-auto">
              <Printer className="h-4 w-4 mr-2" />
              Print Sticker
            </Button>
            <Button variant="outline" onClick={onClose} className="flex-1 w-full md:w-auto">
              Done
            </Button>
          </div>
          
          <Button 
            variant="ghost" 
            onClick={onAddAnother} 
            className="w-full"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Another Asset
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
