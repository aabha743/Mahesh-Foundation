import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AssetCreateFlow } from "@/components/assets/AssetCreateFlow";

export default function NewAssetPage() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(true);

  useEffect(() => {
    setOpen(true);
  }, []);

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Add Asset</h2>
        <p className="text-sm text-muted-foreground">
          Use the same asset registration flow and sticker printing experience as the assets list page.
        </p>
      </div>

      <AssetCreateFlow
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            navigate("/admin/assets");
          }
        }}
        onDone={() => navigate("/admin/assets")}
      />
    </div>
  );
}
