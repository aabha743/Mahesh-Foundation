export type StickerData = {
  serialNumber: string;
  skuName: string;
  centerName: string;
};

export function downloadStickerPNG({ serialNumber, skuName, centerName }: StickerData) {
  const width = 600;
  const height = 400;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // White background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // Outer border
  ctx.strokeStyle = "#e4e4e7";
  ctx.lineWidth = 4;
  ctx.strokeRect(6, 6, width - 12, height - 12);

  ctx.fillStyle = "#000000";
  ctx.textAlign = "center";

  // 1. Mahesh Foundation (Top Heading)
  ctx.font = "bold 28px Arial, sans-serif";
  ctx.fillText("Mahesh Foundation", width / 2, 45);

  // 2. SKU Name (Equipment Name)
  ctx.font = "bold 24px Arial, sans-serif";
  ctx.fillText(skuName, width / 2, 78);

  // 3. Find QR SVG in current DOM or draw text fallback
  const qrSvg = document.querySelector(".sticker-qr svg") || document.querySelector("svg");

  const finishAndDownload = () => {
    // 4. Serial Number (Large Bold Tracking Font)
    ctx.font = "bold 32px Arial, monospace";
    ctx.fillText(serialNumber, width / 2, 315);

    // 5. Center Name (Bottom Line)
    ctx.font = "20px Arial, sans-serif";
    ctx.fillText(centerName, width / 2, 355);

    // Trigger PNG Download for this individual asset
    const a = document.createElement("a");
    a.download = `Sticker_${serialNumber}.png`;
    a.href = canvas.toDataURL("image/png");
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  if (qrSvg) {
    const svgData = new XMLSerializer().serializeToString(qrSvg);
    const img = new Image();
    const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);

    img.onload = () => {
      ctx.drawImage(img, (width - 170) / 2, 95, 170, 170);
      URL.revokeObjectURL(url);
      finishAndDownload();
    };
    img.onerror = () => {
      finishAndDownload();
    };
    img.src = url;
  } else {
    finishAndDownload();
  }
}
