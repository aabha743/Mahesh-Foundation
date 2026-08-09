import { QRCodeSVG } from "qrcode.react";

export type StickerPrintData = {
  serialNumber: string;
  skuName: string;
  centerName: string;
};

type AssetStickerLabelProps = StickerPrintData & {
  className?: string;
  printRoot?: boolean;
};

export function AssetStickerLabel({ serialNumber, skuName, centerName, className, printRoot = false }: AssetStickerLabelProps) {
  return (
    <div className={className} id={printRoot ? "print-sticker-content" : undefined}>
      <div className="sticker-shell">
        <div className="sticker-foundation">Mahesh Foundation</div>
        <div className="sticker-sku">{skuName}</div>
        <div className="sticker-qr">
          <QRCodeSVG value={serialNumber} size={76} includeMargin level="M" />
        </div>
        <div className="sticker-serial">{serialNumber}</div>
        <div className="sticker-center">{centerName}</div>
      </div>
    </div>
  );
}
