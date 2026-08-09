import React from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

interface AssetEditSheetProps {
  asset?: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated?: () => void;
}

export function AssetEditSheet({ open, onOpenChange }: AssetEditSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Edit Asset</SheetTitle>
        </SheetHeader>
        <p className="text-sm text-muted-foreground">Asset edit form.</p>
      </SheetContent>
    </Sheet>
  );
}
