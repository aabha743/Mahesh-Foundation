/**
 * Aadhaar card photos are shrunk in the browser before upload: the longest side to at most 1600 px, saved as
 * JPEG. A phone photo of a card becomes roughly 150-400 KB, well under the server's 1.5 MB limit, and
 * re-drawing it drops the camera's metadata (such as location).
 */

const MAX_SIDE = 1600;
const FALLBACK_MAX_SIDE = 1200;
/** Keep a margin under the server's 1.5 MB limit (base64 makes the upload a third larger again). */
export const MAX_PHOTO_BYTES = 1_400_000;

/** The size to draw a width x height image at so its longest side is at most maxSide (never enlarged). */
export function scaledSize(width: number, height: number, maxSide = MAX_SIDE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width, height };
  const scale = maxSide / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Bytes in a base64 data: URL. */
export function dataUrlBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This file could not be opened as a photo. Please choose a photo of the Aadhaar card."));
    };
    image.src = url;
  });
}

function draw(image: HTMLImageElement, maxSide: number, quality: number): string {
  const { width, height } = scaledSize(image.naturalWidth, image.naturalHeight, maxSide);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not prepare the photo. Please try another browser.");
  context.fillStyle = "#ffffff"; // transparent PNG areas become white, not black
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

/** Shrink a chosen photo and return it as a JPEG data: URL ready to send. */
export async function preparePhoto(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Please choose a photo (JPEG or PNG) of the Aadhaar card.");
  }
  const image = await loadImage(file);
  let dataUrl = draw(image, MAX_SIDE, 0.8);
  if (dataUrlBytes(dataUrl) > MAX_PHOTO_BYTES) dataUrl = draw(image, FALLBACK_MAX_SIDE, 0.6);
  if (dataUrlBytes(dataUrl) > MAX_PHOTO_BYTES) {
    throw new Error("This photo is too large. Please take it again a little further from the card.");
  }
  return dataUrl;
}
