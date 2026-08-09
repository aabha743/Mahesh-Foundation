import React from "react";

interface AssetStickerLabelProps {
  assetTag?: string;
  serialNumber?: string;
  skuName?: string;
}

export function AssetStickerLabel({ assetTag, serialNumber, skuName }: AssetStickerLabelProps) {
  return (
    <div className="p-4 border rounded bg-white text-black text-xs font-mono">
      <div>TAG: {assetTag ?? "N/A"}</div>
      <div>SN: {serialNumber ?? "N/A"}</div>
      <div>ITEM: {skuName ?? "N/A"}</div>
    </div>
  );
}
