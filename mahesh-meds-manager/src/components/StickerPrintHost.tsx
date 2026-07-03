import { useEffect, useState } from "react";
import { AssetStickerLabel, type StickerPrintData } from "@/components/assets/AssetStickerLabel";
import { clearPrintedSticker, subscribeStickerPrint } from "@/lib/printSticker";

export function StickerPrintHost() {
  const [sticker, setSticker] = useState<StickerPrintData | null>(null);

  useEffect(() => {
    return subscribeStickerPrint(setSticker);
  }, []);

  useEffect(() => {
    if (!sticker) return;

    const clear = () => {
      document.body.classList.remove("printing-sticker");
      clearPrintedSticker();
    };

    const triggerPrint = window.setTimeout(() => {
      document.body.classList.add("printing-sticker");
      window.setTimeout(() => {
        window.print();
      }, 40);
    }, 40);

    const fallbackClear = window.setTimeout(clear, 1500);
    window.addEventListener("afterprint", clear, { once: true });

    return () => {
      window.clearTimeout(triggerPrint);
      window.clearTimeout(fallbackClear);
      window.removeEventListener("afterprint", clear);
    };
  }, [sticker]);

  return (
    <div id="sticker-print-host" aria-hidden="true">
      {sticker ? (
        <AssetStickerLabel
          serialNumber={sticker.serialNumber}
          skuName={sticker.skuName}
          centerName={sticker.centerName}
          printRoot
        />
      ) : null}
    </div>
  );
}
