#Pydantic models for the API endpoints, responsible for validating the data received from the frontend and sending the data to the database.
'''Frontend (JSON)
      ↓
Pydantic Schemas (THIS FILE)
      ↓
FastAPI (routes)
      ↓
SQLAlchemy Models (DB mapping)
      ↓
Database (MySQL)'''
from pydantic import BaseModel, ConfigDict, Field
from datetime import date, datetime
from typing import Annotated

MobileNumber = Annotated[str, Field(pattern=r"^\d{10}$")]
AadharNumber = Annotated[str, Field(pattern=r"^\d{12}$")]


# --- Centers ---
class CenterBase(BaseModel):
    name: str
    address: str | None = None
    city: str | None = None
    state: str | None = None
    pin_code: str | None = None
    contact_person: str | None = None
    contact_phone: str | None = None
    is_active: bool = True


class CenterCreate(CenterBase):
    pass


class CenterOut(CenterBase):
    id: str
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


# --- Users ---
class UserBase(BaseModel):
    name: str
    mobile: MobileNumber
    center_id: str | None = None
    is_active: bool = True


class UserCreate(UserBase):
    roles: list[str] = Field(default_factory=list)  # List of role names to assign


class UserOut(UserBase):
    id: str
    roles: list[str] = Field(default_factory=list)  # Resolved role names
    last_login: datetime | None = None
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class UserUpdate(BaseModel):
    name: str | None = None
    mobile: MobileNumber | None = None
    roles: list[str] | None = None  # List of role names to replace existing
    center_id: str | None = None
    is_active: bool | None = None


# --- Audit logs ---
class AuditLogOut(BaseModel):
    id: str
    user_id: str | None = None
    center_id: str | None = None
    action: str
    entity_type: str
    entity_id: str | None = None
    old_value: dict | None = None
    new_value: dict | None = None
    ip_address: str | None = None
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


# --- SKUs ---
class SKUBase(BaseModel):
    name: str
    sku_code: str
    description: str | None = None
    category: str | None = None
    image_url: str | None = None
    is_active: bool = True


class SKUCreate(SKUBase):
    pass


class SKUOut(SKUBase):
    id: str
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class SKUUpdate(BaseModel):
    name: str | None = None
    sku_code: str | None = None
    description: str | None = None
    category: str | None = None
    image_url: str | None = None
    is_active: bool | None = None


# --- Assets ---
class AssetBase(BaseModel):
    sku_id: str
    serial_number: str
    center_id: str | None = None
    home_center_id: str | None = None
    status: str = "available"
    purchase_date: date | None = None
    warranty_expiry: date | None = None
    invoice_number: str | None = None
    invoice_url: str | None = None
    qr_code: str | None = None
    notes: str | None = None

#Passed from the frontend to the database. Uses inheritance from the AssetBase model.defined for future use.
class AssetCreate(BaseModel):
    sku_id: str
    serial_number: str | None = None
    center_id: str | None = None
    home_center_id: str | None = None
    status: str
    purchase_date: date | None = None
    warranty_expiry: date | None = None
    invoice_number: str | None = None
    invoice_url: str | None = None
    qr_code: str | None = None
    notes: str | None = None

#Defined since this output is fetched from the database and not from the frontend.
class AssetOut(AssetBase):
    id: str
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class AssetUpdate(BaseModel):
    status: str | None = None
    center_id: str | None = None
    notes: str | None = None


class AssetOwnershipUpdate(BaseModel):
    home_center_id: str
    center_id: str | None = None
    notes: str | None = None


# --- Lease requests ---
class LeaseRequestBase(BaseModel):
    token_number: str
    requestor_name: str
    mobile: MobileNumber
    aadhar_number: AadharNumber
    patient_name: str | None = None
    patient_aadhar_number: AadharNumber | None = None
    delivery_address: str | None = None
    delivery_landmark: str | None = None
    reference_name: str | None = None
    preferred_center_id: str | None = None
    expected_duration: str | None = None
    notes: str | None = None
    status: str = "pending"
    approval_comments: str | None = None
    rejection_reason: str | None = None


class LeaseRequestItemCreate(BaseModel):
    sku_id: str
    quantity_requested: int = 1
    asset_id: str | None = None


class LeaseRequestCreate(LeaseRequestBase):
    # The server issues the token (MF-<month>-<number>); one sent by the browser is ignored.
    token_number: str | None = None
    patient_name: str
    delivery_address: str
    delivery_landmark: str | None = None
    reference_name: str
    preferred_center_id: str
    items: list[LeaseRequestItemCreate] = Field(default_factory=list)
    # Aadhaar card photos, base64 (a data: URL is fine). Without patient_is_requester the patient's is required too.
    # The length cap sits above the 1.5 MB photo limit, so an oversized photo gets a clear message (app.photo_storage).
    aadhar_photo: str | None = Field(default=None, max_length=2_700_000)
    patient_aadhar_photo: str | None = Field(default=None, max_length=2_700_000)
    patient_is_requester: bool = False
    aadhar_consent: bool = False


class LeaseRequestOut(LeaseRequestBase):
    id: str
    due_date: date | None = None
    created_at: datetime
    updated_at: datetime
    # The photos themselves are only served to reviewers: GET /api/v1/lease-requests/{id}/aadhar-photo/{whose}.
    aadhar_photos_status: str = "none"
    patient_photo_is_requesters: bool = False
    aadhar_consent_at: datetime | None = None
    model_config = ConfigDict(from_attributes=True)


class LeaseRequestItemOut(BaseModel):
    sku_id: str
    sku_name: str
    quantity_requested: int
    asset_id: str | None = None
    due_date: date | None = None
    returned_at: datetime | None = None


class LeaseFulfillmentCenterOut(BaseModel):
    center_id: str
    center_name: str
    item_count: int = 0
    item_names: list[str] = Field(default_factory=list)


class LeaseRequestListOut(LeaseRequestOut):
    skus: list[str] = Field(default_factory=list)
    items: list[LeaseRequestItemOut] = Field(default_factory=list)
    fulfillment_centers: list[LeaseFulfillmentCenterOut] = Field(default_factory=list)
    fulfillment_message: str | None = None
    extension_eligible: bool = False
    extension_eligibility_reason: str | None = None
    pending_extension_request: bool = False
    latest_extension: dict | None = None
    extension_history: list[dict] = Field(default_factory=list)


class PublicLeaseRequestOut(BaseModel):
    id: str
    token_number: str
    requestor_name: str
    mobile: str  # Masked pattern, raw string format
    aadhar_number: str  # Masked pattern, raw string format
    patient_name: str | None = None
    delivery_address: str | None = None
    delivery_landmark: str | None = None
    reference_name: str | None = None
    preferred_center_id: str | None = None
    expected_duration: str | None = None
    notes: str | None = None
    status: str
    approval_comments: str | None = None
    rejection_reason: str | None = None
    due_date: date | None = None
    created_at: datetime
    updated_at: datetime
    skus: list[str] = Field(default_factory=list)
    items: list[LeaseRequestItemOut] = Field(default_factory=list)
    fulfillment_centers: list[LeaseFulfillmentCenterOut] = Field(default_factory=list)
    fulfillment_message: str | None = None
    extension_eligible: bool = False
    extension_eligibility_reason: str | None = None
    pending_extension_request: bool = False
    latest_extension: dict | None = None
    extension_history: list[dict] = Field(default_factory=list)
    model_config = ConfigDict(from_attributes=True)


class LeaseRequestUpdate(BaseModel):
    status: str | None = None
    notes: str | None = None
    rejection_reason: str | None = None
    approval_comments: str | None = None
    items: list[LeaseRequestItemCreate] | None = None


class LeaseReturnItem(BaseModel):
    asset_id: str
    serial_number: str = Field(min_length=1, max_length=100)


class LeaseReturnCreate(BaseModel):
    items: list[LeaseReturnItem] = Field(min_length=1, max_length=50)
    condition: str
    checklist: list[Annotated[str, Field(max_length=100)]] = Field(default_factory=list, max_length=20)
    notes: str | None = Field(default=None, max_length=2000)
    center_id: str | None = None


class LeaseReturnedDeviceOut(BaseModel):
    asset_id: str
    serial_number: str
    status: str


class LeaseReturnOut(BaseModel):
    lease_id: str
    status: str
    returned: list[LeaseReturnedDeviceOut]
    still_out: int


# --- Lease extensions ---
class LeaseExtensionBase(BaseModel):
    token_number: str
    requested_due_date: date
    requested_duration: str | None = None
    reason: str
    requestor_name: str
    mobile: MobileNumber
    aadhar_number: AadharNumber


class LeaseExtensionCreate(LeaseExtensionBase):
    # Taken from the lease (the requester verified its mobile by OTP); older forms still send them.
    requestor_name: str | None = None
    mobile: str | None = None
    aadhar_number: str | None = None


class LeaseExtensionOut(BaseModel):
    id: str
    lease_request_id: str
    token_number: str
    status: str
    requested_duration: str
    requested_days: int
    requested_due_date: date | None = None
    reason: str | None = None
    requestor_name: str
    mobile: str
    aadhar_number: str
    current_due_date: date
    approved_due_date: date | None = None
    approver_comments: str | None = None
    rejection_reason: str | None = None
    requested_at: datetime
    reviewed_at: datetime | None = None
    reviewed_by: str | None = None
    model_config = ConfigDict(from_attributes=True)


class LeaseExtensionReview(BaseModel):
    status: str
    approver_comments: str | None = None
    rejection_reason: str | None = None


# --- Tracking a request (public, OTP to the request's mobile) ---
class TrackOtpRequest(BaseModel):
    query: str = Field(min_length=1, max_length=40)  # a token, or a 10-digit mobile number


class TrackOtpVerify(TrackOtpRequest):
    otp: str = Field(min_length=4, max_length=10)


# --- Device handover (OTP read out by the person collecting the devices) ---
class HandoverOtpRequest(BaseModel):
    center_id: str = Field(min_length=1, max_length=36)  # the center issuing the devices


class HandoverOtpVerify(HandoverOtpRequest):
    otp: str = Field(min_length=4, max_length=10)


# --- Staff login ---
class OTPRequest(BaseModel):
    mobile: str
    purpose: str = "login"


class OTPVerify(BaseModel):
    mobile: str
    otp: str
    purpose: str = "login"


class MeResponse(BaseModel):
    id: str
    name: str
    mobile: str
    center_id: str | None
    roles: list[str]
    permissions: list[str]
