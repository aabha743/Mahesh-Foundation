import React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface AssetCreateFlowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}

export function AssetCreateFlow({ open, onOpenChange }: AssetCreateFlowProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register New Asset</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">Asset creation flow.</p>
      </DialogContent>
    </Dialog>
  );
}
