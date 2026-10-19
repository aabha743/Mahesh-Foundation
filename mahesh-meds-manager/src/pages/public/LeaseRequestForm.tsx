import { useMemo, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle, Plus, Minus, Search, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { PublicHeader, PublicFooter } from "@/components/PublicHeader";
import { Checkbox } from "@/components/ui/checkbox";
import { ApiError, apiFetch } from "@/lib/api";
import { RequiredMark } from "@/components/RequiredMark";
import { AadharPhotoInput } from "@/components/AadharPhotoInput";

const durations = ["1 Week", "2 Weeks", "3 Weeks", "4 Weeks"];

// Used for the initial form and for "Submit Another Request", so a reset clears every field.
const EMPTY_FORM = {
  name: "",
  mobile: "",
  aadhar: "",
  /** Photos are JPEG data: URLs, shrunk in the browser (lib/photoUpload). */
  aadharPhoto: null as string | null,
  patientIsRequester: false,
  patientName: "",
  patientAadhar: "",
  patientAadharPhoto: null as string | null,
  aadharConsent: false,
  deliveryAddress: "",
  deliveryLandmark: "",
  referredBy: "",
  preferredCenterId: "",
  duration: "",
  notes: "",
};

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
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [filterArea, setFilterArea] = useState("all");
  const [filterSku, setFilterSku] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const closeSearch = () => {
    setSearchTerm("");
    setSearchOpen(false);
  };

  const centerNameToId = useMemo(
    () => Object.fromEntries(centers.map((center) => [center.name, center.id])),
    [centers],
  );

  const selectedCount = Object.values(quantities).filter((q) => q > 0).length;

  const isSplitCollectionNeeded = useMemo(() => {
    if (!formData.preferredCenterId) return false;
    const selectedSkuIds = Object.entries(quantities)
      .filter(([, qty]) => qty > 0)
      .map(([skuId]) => skuId);

    return selectedSkuIds.some((skuId) => {
      const hasLocalAsset = assets.some(
        (asset) =>
          asset.sku_id === skuId &&
          asset.center_id === formData.preferredCenterId &&
          asset.status === "available"
      );
      return !hasLocalAsset;
    });
  }, [formData.preferredCenterId, quantities, assets]);

  const [stockItems, setStockItems] = useState<Array<{ sku_id: string; center_id: string; available_count: number }>>([]);

  useEffect(() => {
    async function loadData() {
      try {
        const [centersResp, skusResp, assetsResp, stockResp] = await Promise.all([
          apiFetch<Array<{ id: string; name: string }>>("/api/v1/centers"),
          apiFetch<Array<{ id: string; name: string; category: string | null; image_url: string | null }>>("/api/v1/skus"),
          apiFetch<Array<{ sku_id: string; center_id: string | null; status: string }>>("/api/v1/assets"),
          apiFetch<Array<{ sku_id: string; center_id: string; available_count: number }>>("/api/v1/stock"),
        ]);
        setCenters(centersResp);
        setSkus(skusResp);
        setAssets(assetsResp);
        setStockItems(stockResp);
      } catch {
        // keep page functional; submit will still fail clearly if API is unavailable
      }
    }
    loadData();
  }, []);

  const filteredSKUs = useMemo(() => {
    const selectedCenterId = filterArea === "all" ? null : centerNameToId[filterArea];
    const availableBySku = new Map<string, number>();

    stockItems.forEach((st) => {
      if (st.available_count <= 0) return;
      if (selectedCenterId && st.center_id !== selectedCenterId) return;
      availableBySku.set(st.sku_id, (availableBySku.get(st.sku_id) ?? 0) + st.available_count);
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
  }, [skus, stockItems, filterArea, filterSku, searchTerm, centerNameToId]);

  const centerIdToName = useMemo(
    () => Object.fromEntries(centers.map((center) => [center.id, center.name])),
    [centers],
  );

  const updateQty = (id: string, delta: number) => {
    setQuantities((p) => {
      const cur = p[id] || 0;
      const next = Math.max(0, Math.min(1, cur + delta));
      setErrors((prev) => {
        if (!prev.items) return prev;
        const { items, ...rest } = prev;
        return rest;
      });
      return { ...p, [id]: next };
    });
  };

  // The Aadhaar fields drop their error as soon as they are filled in, so a photo never sits next to "Add a photo".
  const clearErrors = (...keys: string[]) =>
    setErrors((prev) => {
      if (!keys.some((key) => prev[key])) return prev;
      const next = { ...prev };
      keys.forEach((key) => delete next[key]);
      return next;
    });

  const validate = () => {
    const e: Record<string, string> = {};
    if (!formData.name.trim()) e.name = "Name is required";
    if (!/^\d{10}$/.test(formData.mobile)) e.mobile = "Enter valid 10-digit mobile";
    if (!/^\d{12}$/.test(formData.aadhar.replace(/\s/g, ""))) e.aadhar = "Enter valid 12-digit Aadhaar";
    if (!formData.aadharPhoto) e.aadharPhoto = "Add a photo of the requester's Aadhaar card";
    if (!formData.patientIsRequester) {
      if (!formData.patientName.trim()) e.patientName = "Patient name is required";
      if (!/^\d{12}$/.test(formData.patientAadhar.replace(/\s/g, ""))) e.patientAadhar = "Enter valid 12-digit Aadhaar";
      if (!formData.patientAadharPhoto) e.patientAadharPhoto = "Add a photo of the patient's Aadhaar card";
    }
    if (!formData.aadharConsent) e.aadharConsent = "Please agree to continue";
    if (!formData.deliveryAddress.trim()) e.deliveryAddress = "Delivery address is required";
    if (!formData.referredBy.trim()) e.referredBy = "Referral source is required";
    if (!formData.preferredCenterId) e.preferredCenterId = "Preferred pickup center is required";
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

    setIsSubmitting(true);
    try {
      // The server issues the token (MF-<month>-<number>).
      const created = await apiFetch<{ token_number: string }>("/api/v1/lease-requests", {
        method: "POST",
        body: JSON.stringify({
          requestor_name: formData.name.trim(),
          mobile: formData.mobile.trim(),
          aadhar_number: formData.aadhar.replace(/\s/g, ""),
          aadhar_photo: formData.aadharPhoto,
          patient_is_requester: formData.patientIsRequester,
          patient_name: formData.patientIsRequester ? formData.name.trim() : formData.patientName.trim(),
          patient_aadhar_number: formData.patientIsRequester ? null : formData.patientAadhar.replace(/\s/g, ""),
          patient_aadhar_photo: formData.patientIsRequester ? null : formData.patientAadharPhoto,
          aadhar_consent: formData.aadharConsent,
          delivery_address: formData.deliveryAddress.trim(),
          delivery_landmark: formData.deliveryLandmark.trim() || null,
          reference_name: formData.referredBy.trim(),
          preferred_center_id: formData.preferredCenterId,
          expected_duration: formData.duration,
          notes: formData.notes.trim() || null,
          items: selectedItems,
        }),
      });
      setSubmittedToken(created.token_number);
      setSubmitted(true);
    } catch (error) {
      // Show the server's reason (e.g. a photo it could not use), except for raw validation output.
      const reason = error instanceof ApiError && error.status !== 422 && error.message ? error.message : "";
      setErrors((prev) => ({ ...prev, submit: reason || "Unable to submit request. Please try again." }));
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
                <p className="text-xs text-muted-foreground mt-1">You can track it later with this token or your mobile number; we'll text an OTP to your mobile to confirm it's you.</p>
              </div>
              <div className="flex flex-col gap-2">
                <Button onClick={() => navigate(`/status?token=${submittedToken}`)}>Track My Request</Button>
                <Button variant="outline" onClick={() => { setSubmitted(false); setQuantities({}); setShowForm(false); setFormData(EMPTY_FORM); }}>Submit Another Request</Button>
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
            <div className="grid grid-cols-[1fr_auto] gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
              <div className="col-span-2 space-y-1.5 md:col-span-1">
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
              <Button
                type="button"
                variant={searchOpen || searchTerm ? "default" : "outline"}
                size="icon"
                className="h-11 w-11 shrink-0 self-end"
                aria-label="Search devices"
                aria-expanded={searchOpen}
                onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
              >
                <Search className="h-5 w-5" />
              </Button>
            </div>

            {searchOpen && (
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && closeSearch()}
                  placeholder="Search device or category..."
                  aria-label="Search device or category"
                  className="min-h-11 pl-9 pr-11"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 h-9 w-9 -translate-y-1/2"
                  aria-label="Clear and close search"
                  onClick={closeSearch}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            )}

            <Card>
              <CardContent className="p-0">
                <div className="md:hidden space-y-3 p-4">
                  {filteredSKUs.map((sku) => {
                    const selectedCenterId = filterArea === "all" ? null : centerNameToId[filterArea];
                    const matchingStock = stockItems.filter((st) => {
                      if (st.sku_id !== sku.id || st.available_count <= 0) return false;
                      if (selectedCenterId && st.center_id !== selectedCenterId) return false;
                      return true;
                    });
                    const availableCount = matchingStock.reduce((acc, curr) => acc + curr.available_count, 0);
                    const isAvailable = availableCount > 0;
                    const availabilityLabel = availableCount === 0 ? "Unavailable" : availableCount <= 2 ? "Limited" : "Available";
                    const availableCenters = Array.from(
                      new Set(
                        matchingStock
                          .map((st) => st.center_id)
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
                            <Button size="icon" variant="outline" className="h-9 w-9" onClick={() => updateQty(sku.id, 1)} disabled={!isAvailable || qty >= 1}>
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
                      const matchingStock = stockItems.filter((st) => {
                        if (st.sku_id !== sku.id || st.available_count <= 0) return false;
                        if (selectedCenterId && st.center_id !== selectedCenterId) return false;
                        return true;
                      });
                      const availableCount = matchingStock.reduce((acc, curr) => acc + curr.available_count, 0);
                      const isAvailable = availableCount > 0;
                      const availabilityLabel = availableCount === 0 ? "Unavailable" : availableCount <= 2 ? "Limited" : "Available";
                      const availableCenters = Array.from(
                        new Set(
                          matchingStock
                            .map((st) => st.center_id)
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
                            {availableCenters.length > 0 ? availableCenters.join(" | ") : "-"}
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
                              <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => updateQty(sku.id, 1)} disabled={!isAvailable || qty >= 1}>
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
            <CardContent className="p-4 md:p-6 space-y-6">
              <div>
                <div className="space-y-1 border-b border-border pb-4">
                  <h3 className="text-base md:text-lg font-semibold text-foreground">Requestor Details</h3>
                  <p className="text-sm text-muted-foreground">Enter the contact details of the person filling out this form.</p>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="requestor-name">Full Name<RequiredMark /></Label>
                    <Input
                      id="requestor-name"
                      className="min-h-11"
                      value={formData.name}
                      onChange={(e) => setFormData((p) => ({ ...p, name: e.target.value }))}
                      placeholder="Enter requestor full name"
                    />
                    {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="requestor-mobile">Mobile Number<RequiredMark /></Label>
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

                  <div className="space-y-1.5">
                    <Label htmlFor="requestor-aadhar">Aadhar Number<RequiredMark /></Label>
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
                    <Label htmlFor="requestor-referrer">Referred By<RequiredMark /></Label>
                    <Input
                      id="requestor-referrer"
                      className="min-h-11"
                      value={formData.referredBy}
                      onChange={(e) => setFormData((p) => ({ ...p, referredBy: e.target.value }))}
                      placeholder="Doctor / social worker name"
                    />
                    {errors.referredBy && <p className="text-xs text-destructive">{errors.referredBy}</p>}
                  </div>

                  <div className="space-y-1.5 md:col-span-2">
                    <Label htmlFor="requestor-aadhar-photo">Photo of Aadhaar Card<RequiredMark /></Label>
                    <AadharPhotoInput
                      id="requestor-aadhar-photo"
                      subject="requester's Aadhaar card"
                      value={formData.aadharPhoto}
                      onChange={(photo) => {
                        setFormData((p) => ({ ...p, aadharPhoto: photo }));
                        if (photo) clearErrors("aadharPhoto");
                      }}
                      error={errors.aadharPhoto}
                    />
                  </div>
                </div>
              </div>

              <div>
                <div className="space-y-1 border-b border-border pb-4">
                  <h3 className="text-base md:text-lg font-semibold text-foreground">Patient &amp; Delivery Details</h3>
                  <p className="text-sm text-muted-foreground">Enter the details of the patient receiving the device and where it will be taken.</p>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="flex items-center gap-3 md:col-span-2">
                    <Checkbox
                      id="patient-is-requester"
                      checked={formData.patientIsRequester}
                      onCheckedChange={(checked) => {
                        setFormData((p) => ({ ...p, patientIsRequester: checked === true }));
                        if (checked === true) clearErrors("patientName", "patientAadhar", "patientAadharPhoto");
                      }}
                    />
                    <Label htmlFor="patient-is-requester" className="font-normal">I am the patient</Label>
                  </div>

                  {formData.patientIsRequester ? (
                    <p className="text-sm text-muted-foreground md:col-span-2">
                      Your name, Aadhaar number and Aadhaar photo above will be used for the patient.
                    </p>
                  ) : (
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor="patient-name">Patient's Name<RequiredMark /></Label>
                        <Input
                          id="patient-name"
                          className="min-h-11"
                          value={formData.patientName}
                          onChange={(e) => {
                            const value = e.target.value;
                            setFormData((p) => ({ ...p, patientName: value }));
                            if (value.trim()) clearErrors("patientName");
                          }}
                          placeholder="Name of the person receiving the device"
                        />
                        {errors.patientName && <p className="text-xs text-destructive">{errors.patientName}</p>}
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="patient-aadhar">Patient's Aadhar Number<RequiredMark /></Label>
                        <Input
                          id="patient-aadhar"
                          className="min-h-11"
                          inputMode="numeric"
                          value={formData.patientAadhar}
                          onChange={(e) => {
                            const value = formatAadhar(e.target.value);
                            setFormData((p) => ({ ...p, patientAadhar: value }));
                            if (value.replace(/\s/g, "").length === 12) clearErrors("patientAadhar");
                          }}
                          placeholder="XXXX XXXX XXXX"
                          maxLength={14}
                        />
                        {errors.patientAadhar && <p className="text-xs text-destructive">{errors.patientAadhar}</p>}
                      </div>

                      <div className="space-y-1.5 md:col-span-2">
                        <Label htmlFor="patient-aadhar-photo">Photo of Patient's Aadhaar Card<RequiredMark /></Label>
                        <AadharPhotoInput
                          id="patient-aadhar-photo"
                          subject="patient's Aadhaar card"
                          value={formData.patientAadharPhoto}
                          onChange={(photo) => {
                            setFormData((p) => ({ ...p, patientAadharPhoto: photo }));
                            if (photo) clearErrors("patientAadharPhoto");
                          }}
                          error={errors.patientAadharPhoto}
                        />
                      </div>
                    </>
                  )}

                  <div className="space-y-1.5 md:col-span-2">
                    <Label htmlFor="delivery-address">Delivery Address<RequiredMark /></Label>
                    <Textarea
                      id="delivery-address"
                      className="min-h-20 resize-y"
                      value={formData.deliveryAddress}
                      onChange={(e) => setFormData((p) => ({ ...p, deliveryAddress: e.target.value }))}
                      placeholder="Full address where the device will be taken to"
                    />
                    {errors.deliveryAddress && <p className="text-xs text-destructive">{errors.deliveryAddress}</p>}
                  </div>

                  <div className="space-y-1.5 md:col-span-2">
                    <Label htmlFor="delivery-landmark">Closest Landmark <span className="font-normal text-muted-foreground">(optional)</span></Label>
                    <Input
                      id="delivery-landmark"
                      className="min-h-11"
                      value={formData.deliveryLandmark}
                      onChange={(e) => setFormData((p) => ({ ...p, deliveryLandmark: e.target.value }))}
                      placeholder="Closest landmark to the delivery address"
                    />
                  </div>
                </div>
              </div>

              <div>
                <div className="space-y-1 border-b border-border pb-4">
                  <h3 className="text-base md:text-lg font-semibold text-foreground">Pickup Details</h3>
                  <p className="text-sm text-muted-foreground">Select your preferred pickup center and duration.</p>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="preferred-center">Preferred Pickup Center<RequiredMark /></Label>
                    <Select value={formData.preferredCenterId} onValueChange={(v) => setFormData((p) => ({ ...p, preferredCenterId: v }))}>
                      <SelectTrigger id="preferred-center" className="min-h-11">
                        <SelectValue placeholder="Select pickup center" />
                      </SelectTrigger>
                      <SelectContent>
                        {centers.map((c) => (
                          <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {errors.preferredCenterId && <p className="text-xs text-destructive">{errors.preferredCenterId}</p>}
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="expected-duration">Expected Duration<RequiredMark /></Label>
                    <Select value={formData.duration} onValueChange={(v) => setFormData((p) => ({ ...p, duration: v }))}>
                      <SelectTrigger id="expected-duration" className="min-h-11">
                        <SelectValue placeholder="Select duration" />
                      </SelectTrigger>
                      <SelectContent>{durations.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
                    </Select>
                    {errors.duration && <p className="text-xs text-destructive">{errors.duration}</p>}
                  </div>
                </div>
              </div>

              {isSplitCollectionNeeded && (
                <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-3 text-sm text-warning font-medium">
                  Note: Since not all selected items are available at your preferred pickup center, if your request gets approved, you will have to collect the devices from their respective centers.
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="request-notes">Additional Notes</Label>
                <Textarea
                  id="request-notes"
                  className="min-h-24 resize-y"
                  value={formData.notes}
                  onChange={(e) => setFormData((p) => ({ ...p, notes: e.target.value }))}
                  placeholder="Any special requirements..."
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3">
                  <Checkbox
                    id="aadhar-consent"
                    className="mt-0.5"
                    checked={formData.aadharConsent}
                    onCheckedChange={(checked) => {
                      setFormData((p) => ({ ...p, aadharConsent: checked === true }));
                      if (checked === true) clearErrors("aadharConsent");
                    }}
                  />
                  <Label htmlFor="aadhar-consent" className="text-sm font-normal leading-relaxed">
                    I consent to Mahesh Foundation storing the Aadhaar numbers and card photos of the requester and patient to verify identity for this equipment loan. They are seen only by Foundation staff who review requests.
                    <RequiredMark />
                  </Label>
                </div>
                {errors.aadharConsent && <p className="text-xs text-destructive">{errors.aadharConsent}</p>}
              </div>

              {errors.submit && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {errors.submit}
                </div>
              )}

              <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 md:flex-row md:justify-end">
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
