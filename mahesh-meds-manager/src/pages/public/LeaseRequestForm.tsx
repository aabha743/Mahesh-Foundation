import { useMemo, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle, Plus, Minus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { PublicHeader, PublicFooter } from "@/components/PublicHeader";
import { apiFetch } from "@/lib/api";

const durations = ["1 Week", "2 Weeks", "1 Month", "3 Months", "Longer"];

function SkuThumbnail({ name, imageUrl }: { name: string; imageUrl: string | null }) {
  const [hasError, setHasError] = useState(false);

  if (!imageUrl || hasError) {
    return (
      <div className="h-12 w-12 sm:h-16 sm:w-16 shrink-0 rounded-md border bg-muted overflow-hidden flex items-center justify-center">
        <span className="text-xs font-semibold text-muted-foreground">{name[0]}</span>
      </div>
    );
  }

  return (
    <div className="h-12 w-12 sm:h-16 sm:w-16 shrink-0 rounded-md border bg-muted overflow-hidden flex items-center justify-center">
      <img
        src={imageUrl}
        alt={name}
        className="h-full w-full object-cover"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setHasError(true)}
      />
    </div>
  );
}

export default function LeaseRequestForm() {
  const navigate = useNavigate();
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [showForm, setShowForm] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submittedToken, setSubmittedToken] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [skus, setSkus] = useState<Array<{ id: string; name: string; category: string | null; image_url: string | null }>>([]);
  const [centers, setCenters] = useState<Array<{ id: string; name: string }>>([]);
  const [assets, setAssets] = useState<Array<{ sku_id: string; center_id: string | null; status: string }>>([]);
  const [formData, setFormData] = useState({ name: "", mobile: "", aadhar: "", referredBy: "", duration: "", notes: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [filterArea, setFilterArea] = useState("all");
  const [filterSku, setFilterSku] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");

  const centerNameToId = useMemo(
    () => Object.fromEntries(centers.map((center) => [center.name, center.id])),
    [centers],
  );

  const selectedCount = Object.values(quantities).filter((q) => q > 0).length;

  useEffect(() => {
    async function loadData() {
      try {
        const [centersResp, skusResp, assetsResp] = await Promise.all([
          apiFetch<Array<{ id: string; name: string }>>("/api/v1/centers"),
          apiFetch<Array<{ id: string; name: string; category: string | null; image_url: string | null }>>("/api/v1/skus"),
          apiFetch<Array<{ sku_id: string; center_id: string | null; status: string }>>("/api/v1/assets"),
        ]);
        setCenters(centersResp);
        setSkus(skusResp);
        setAssets(assetsResp);
      } catch {
        // keep page functional; submit will still fail clearly if API is unavailable
      }
    }
    loadData();
  }, []);

  const filteredSKUs = useMemo(() => {
    const selectedCenterId = filterArea === "all" ? null : centerNameToId[filterArea];
    const availableBySku = new Map<string, number>();
    assets.forEach((asset) => {
      if (asset.status !== "available") return;
      if (selectedCenterId && asset.center_id !== selectedCenterId) return;
      availableBySku.set(asset.sku_id, (availableBySku.get(asset.sku_id) ?? 0) + 1);
    });

    return skus.filter((sku) => {
      if (filterSku !== "all" && sku.id !== filterSku) return false;
      if (selectedCenterId && (availableBySku.get(sku.id) ?? 0) === 0) return false;
      if (searchTerm.trim()) {
        const q = searchTerm.trim().toLowerCase();
        const inName = sku.name.toLowerCase().includes(q);
        const inCategory = (sku.category ?? "").toLowerCase().includes(q);
        if (!inName && !inCategory) return false;
      }
      return true;
    });
  }, [skus, assets, filterArea, filterSku, searchTerm, centerNameToId]);

  const centerIdToName = useMemo(
    () => Object.fromEntries(centers.map((center) => [center.id, center.name])),
    [centers],
  );

  const updateQty = (id: string, delta: number) => {
    setQuantities((p) => {
      const cur = p[id] || 0;
      const next = Math.max(0, cur + delta);
      setErrors((prev) => {
        if (!prev.items) return prev;
        const { items, ...rest } = prev;
        return rest;
      });
      return { ...p, [id]: next };
    });
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!formData.name.trim()) e.name = "Name is required";
    if (!/^\d{10}$/.test(formData.mobile)) e.mobile = "Enter valid 10-digit mobile";
    if (!/^\d{12}$/.test(formData.aadhar.replace(/\s/g, ""))) e.aadhar = "Enter valid 12-digit Aadhar";
    if (!formData.duration) e.duration = "Select duration";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    const selectedItems = Object.entries(quantities)
      .filter(([, qty]) => qty > 0)
      .map(([skuId, qty]) => ({ sku_id: skuId, quantity_requested: qty }));
    if (selectedItems.length === 0) {
      setErrors((prev) => ({ ...prev, items: "Select at least one device" }));
      return;
    }

    const token = "MDF-" + Math.random().toString(36).substring(2, 8).toUpperCase();
    setIsSubmitting(true);
    try {
      await apiFetch("/api/v1/lease-requests", {
        method: "POST",
        body: JSON.stringify({
          token_number: token,
          requestor_name: formData.name.trim(),
          mobile: formData.mobile.trim(),
          aadhar_number: formData.aadhar.replace(/\s/g, ""),
          reference_name: formData.referredBy.trim() || null,
          expected_duration: formData.duration,
          notes: formData.notes.trim() || null,
          status: "pending",
          items: selectedItems,
        }),
      });
      setSubmittedToken(token);
      setSubmitted(true);
    } catch {
      setErrors((prev) => ({ ...prev, submit: "Unable to submit request. Please try again." }));
    } finally {
      setIsSubmitting(false);
    }
  };

  const formatAadhar = (v: string) => {
    const digits = v.replace(/\D/g, "").slice(0, 12);
    return digits.replace(/(\d{4})(?=\d)/g, "$1 ").trim();
  };

  if (submitted) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <PublicHeader />
        <main className="flex-1 flex items-center justify-center p-4">
          <Card className="max-w-md w-full text-center">
            <CardContent className="py-10 space-y-4">
              <CheckCircle className="h-16 w-16 text-success mx-auto" />
              <h2 className="text-xl font-semibold text-foreground">Request Submitted!</h2>
              <div className="bg-muted rounded-lg p-4">
                <p className="text-sm text-muted-foreground">Your Token Number</p>
                <p className="text-2xl font-bold font-mono text-primary mt-1">{submittedToken}</p>
                <p className="text-xs text-muted-foreground mt-1">You can track later with this token number or your mobile number.</p>
              </div>
              <div className="flex flex-col gap-2">
                <Button onClick={() => navigate(`/status?token=${submittedToken}`)}>Track My Request</Button>
                <Button variant="outline" onClick={() => { setSubmitted(false); setQuantities({}); setShowForm(false); setFormData({ name: "", mobile: "", aadhar: "", referredBy: "", duration: "", notes: "" }); }}>Submit Another Request</Button>
              </div>
            </CardContent>
          </Card>
        </main>
        <PublicFooter />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <PublicHeader />
      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6 md:px-6 space-y-6">
        <div className="text-center space-y-1">
          <h2 className="text-xl md:text-2xl font-bold text-foreground">MF MEDICAL EQUIPMENT SEVA(MES)</h2>
          <p className="text-muted-foreground">Select the devices you need and submit a request</p>
        </div>

        {!showForm && (
          <>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3 md:items-end">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">Filter by area</Label>
                <Select value={filterArea} onValueChange={setFilterArea}>
                  <SelectTrigger className="min-h-11"><SelectValue placeholder="Filter by Area" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Areas</SelectItem>
                    {centers.map((c) => (
                      <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">Filter by device</Label>
                <Select value={filterSku} onValueChange={setFilterSku}>
                  <SelectTrigger className="min-h-11"><SelectValue placeholder="Filter by Device" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Devices</SelectItem>
                    {skus.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">Search</Label>
                <Input
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search device or category..."
                  className="min-h-11"
                />
              </div>
            </div>

            <Card>
              <CardContent className="p-0">
                <div className="md:hidden space-y-3 p-4">
                  {filteredSKUs.map((sku) => {
                    const selectedCenterId = filterArea === "all" ? null : centerNameToId[filterArea];
                    const matchingAssets = assets.filter((asset) => {
                      if (asset.sku_id !== sku.id || asset.status !== "available") return false;
                      if (selectedCenterId && asset.center_id !== selectedCenterId) return false;
                      return true;
                    });
                    const availableCount = matchingAssets.length;
                    const isAvailable = availableCount > 0;
                    const availabilityLabel = availableCount === 0 ? "Unavailable" : availableCount <= 2 ? "Limited" : "Available";
                    const availableCenters = Array.from(
                      new Set(
                        matchingAssets
                          .map((asset) => asset.center_id)
                          .filter((centerId): centerId is string => Boolean(centerId))
                          .map((centerId) => centerIdToName[centerId])
                          .filter((name): name is string => Boolean(name)),
                      ),
                    );
                    const qty = quantities[sku.id] || 0;

                    return (
                      <div key={sku.id} className="rounded-lg border bg-card p-4 space-y-3">
                        <div className="flex items-start gap-3">
                          <SkuThumbnail name={sku.name} imageUrl={sku.image_url} />
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold text-foreground">{sku.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {availableCenters.length > 0 ? availableCenters.join(", ") : "No center currently available"}
                            </p>
                          </div>
                          <Badge
                            variant="outline"
                            className={
                              availabilityLabel === "Available"
                                ? "bg-success/15 text-success border-success/30"
                                : availabilityLabel === "Limited"
                                  ? "bg-warning/15 text-warning border-warning/30"
                                  : "bg-destructive/15 text-destructive border-destructive/30"
                            }
                          >
                            {availabilityLabel}
                          </Badge>
                        </div>
                        <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2">
                          <span className="text-sm text-muted-foreground">Quantity</span>
                          <div className="flex items-center gap-2">
                            <Button size="icon" variant="outline" className="h-9 w-9" onClick={() => updateQty(sku.id, -1)} disabled={qty === 0}>
                              <Minus className="h-4 w-4" />
                            </Button>
                            <span className="w-8 text-center font-medium">{qty}</span>
                            <Button size="icon" variant="outline" className="h-9 w-9" onClick={() => updateQty(sku.id, 1)} disabled={!isAvailable}>
                              <Plus className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {filteredSKUs.length === 0 && (
                    <div className="text-center text-muted-foreground py-8">
                      No devices found for the selected filters.
                    </div>
                  )}
                </div>

                <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Device</TableHead>
                      <TableHead>Available At</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredSKUs.map((sku) => {
                      const selectedCenterId = filterArea === "all" ? null : centerNameToId[filterArea];
                      const matchingAssets = assets.filter((asset) => {
                        if (asset.sku_id !== sku.id || asset.status !== "available") return false;
                        if (selectedCenterId && asset.center_id !== selectedCenterId) return false;
                        return true;
                      });
                      const availableCount = matchingAssets.length;
                      const isAvailable = availableCount > 0;
                      const availabilityLabel = availableCount === 0 ? "Unavailable" : availableCount <= 2 ? "Limited" : "Available";
                      const availableCenters = Array.from(
                        new Set(
                          matchingAssets
                            .map((asset) => asset.center_id)
                            .filter((centerId): centerId is string => Boolean(centerId))
                            .map((centerId) => centerIdToName[centerId])
                            .filter((name): name is string => Boolean(name)),
                        ),
                      );
                      const qty = quantities[sku.id] || 0;
                      return (
                        <TableRow key={sku.id}>
                          <TableCell>
                            <div className="flex items-center gap-3">
                              <SkuThumbnail name={sku.name} imageUrl={sku.image_url} />
                              <span className="font-medium">{sku.name}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {availableCenters.length > 0 ? availableCenters.join(" | ") : "â€”"}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={
                                availabilityLabel === "Available"
                                  ? "bg-success/15 text-success border-success/30"
                                  : availabilityLabel === "Limited"
                                    ? "bg-warning/15 text-warning border-warning/30"
                                    : "bg-destructive/15 text-destructive border-destructive/30"
                              }
                            >
                              {availabilityLabel}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-2">
                              <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => updateQty(sku.id, -1)} disabled={qty === 0}>
                                <Minus className="h-3 w-3" />
                              </Button>
                              <span className="w-6 text-center font-medium text-sm">{qty}</span>
                              <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => updateQty(sku.id, 1)} disabled={!isAvailable}>
                                <Plus className="h-3 w-3" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {filteredSKUs.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                          No devices found for the selected filters.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
                </div>
              </CardContent>
            </Card>

            {selectedCount > 0 && (
              <>
                <div className="sticky bottom-0 z-10 -mx-4 rounded-t-lg border-t border-border bg-card p-4 shadow-lg backdrop-blur sm:flex sm:items-center sm:justify-between">
                  <span className="text-sm font-medium text-foreground">{selectedCount} item{selectedCount > 1 ? "s" : ""} selected</span>
                  <Button onClick={() => setShowForm(true)} className="mt-3 min-h-12 w-full sm:mt-0 sm:w-auto">Continue to Details</Button>
                </div>
                {errors.items && <p className="text-xs text-destructive">{errors.items}</p>}
              </>
            )}
          </>
        )}

        {showForm && (
          <Card className="mx-auto w-full max-w-3xl">
            <CardContent className="p-4 md:p-6">
              <div className="space-y-1 border-b border-border pb-4">
                <h3 className="text-base md:text-lg font-semibold text-foreground">Your Details</h3>
                <p className="text-sm text-muted-foreground">Enter the requestor details exactly as they should appear on the request.</p>
              </div>

              <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="requestor-name">Full Name *</Label>
                  <Input
                    id="requestor-name"
                    className="min-h-11"
                    value={formData.name}
                    onChange={(e) => setFormData((p) => ({ ...p, name: e.target.value }))}
                    placeholder="Enter your full name"
                  />
                  {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="requestor-mobile">Mobile Number *</Label>
                  <div className="flex items-stretch gap-2">
                    <span className="inline-flex min-h-11 items-center rounded-md border border-input bg-muted px-3 text-sm text-muted-foreground">+91</span>
                    <Input
                      id="requestor-mobile"
                      className="min-h-11"
                      value={formData.mobile}
                      onChange={(e) => setFormData((p) => ({ ...p, mobile: e.target.value.replace(/\D/g, "").slice(0, 10) }))}
                      placeholder="10-digit number"
                    />
                  </div>
                  {errors.mobile && <p className="text-xs text-destructive">{errors.mobile}</p>}
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="requestor-aadhar">Aadhar Number *</Label>
                  <Input
                    id="requestor-aadhar"
                    className="min-h-11"
                    value={formData.aadhar}
                    onChange={(e) => setFormData((p) => ({ ...p, aadhar: formatAadhar(e.target.value) }))}
                    placeholder="XXXX XXXX XXXX"
                    maxLength={14}
                  />
                  {errors.aadhar && <p className="text-xs text-destructive">{errors.aadhar}</p>}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="requestor-duration">Expected Duration *</Label>
                  <Select value={formData.duration} onValueChange={(v) => setFormData((p) => ({ ...p, duration: v }))}>
                    <SelectTrigger id="requestor-duration" className="min-h-11">
                      <SelectValue placeholder="Select duration" />
                    </SelectTrigger>
                    <SelectContent>{durations.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
                  </Select>
                  {errors.duration && <p className="text-xs text-destructive">{errors.duration}</p>}
                </div>
              </div>

              <div className="mt-4 space-y-1.5">
                <Label htmlFor="requestor-referrer">Recommended by</Label>
                <Input
                  id="requestor-referrer"
                  className="min-h-11"
                  value={formData.referredBy}
                  onChange={(e) => setFormData((p) => ({ ...p, referredBy: e.target.value }))}
                  placeholder="Doctor / social worker name"
                />
              </div>

              <div className="mt-4 space-y-1.5">
                <Label htmlFor="request-notes">Additional Notes</Label>
                <Textarea
                  id="request-notes"
                  className="min-h-28 resize-y"
                  value={formData.notes}
                  onChange={(e) => setFormData((p) => ({ ...p, notes: e.target.value }))}
                  placeholder="Any special requirements..."
                />
              </div>

              {errors.submit && (
                <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {errors.submit}
                </div>
              )}

              <div className="mt-6 flex flex-col-reverse gap-2 border-t border-border pt-4 md:flex-row md:justify-end">
                <Button variant="outline" onClick={() => setShowForm(false)} className="min-h-12 w-full md:w-auto">Back</Button>
                <Button className="min-h-12 w-full bg-success text-success-foreground hover:bg-success/90 md:w-auto md:min-w-48" onClick={handleSubmit} disabled={isSubmitting}>
                  {isSubmitting ? "Submitting..." : "Submit Request"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </main>
      <PublicFooter />
    </div>
  );
}
