import type { StickerPrintData } from "@/components/assets/AssetStickerLabel";

type Listener = (payload: StickerPrintData | null) => void;

let currentSticker: StickerPrintData | null = null;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach((listener) => listener(currentSticker));
}

export function subscribeStickerPrint(listener: Listener) {
  listeners.add(listener);
  listener(currentSticker);
  return () => {
    listeners.delete(listener);
  };
}

export function printSticker(sticker: StickerPrintData) {
  currentSticker = sticker;
  notify();
}

export function clearPrintedSticker() {
  currentSticker = null;
  notify();
}
