import React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface AssetQrDialogProps {
  asset?: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AssetQrDialog({ open, onOpenChange }: AssetQrDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Asset QR Code</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">Asset QR code preview.</p>
      </DialogContent>
    </Dialog>
  );
}
