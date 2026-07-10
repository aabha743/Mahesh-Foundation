#OBJECT RELATIONAL MAPPING (ORM) MODELS FOR THE DATABASE
import uuid
from datetime import datetime

from sqlalchemy import JSON, Boolean, CheckConstraint, Date, DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.mysql import CHAR
from sqlalchemy.orm import Mapped, mapped_column, relationship, declarative_base

from app.database import Base


# Master table: service locations/centers.
class Center(Base):
    __tablename__ = "centers"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    address: Mapped[str | None] = mapped_column(Text)
    city: Mapped[str | None] = mapped_column(String(100))
    state: Mapped[str | None] = mapped_column(String(100))
    pin_code: Mapped[str | None] = mapped_column(String(10))
    contact_person: Mapped[str | None] = mapped_column(String(150))
    contact_phone: Mapped[str | None] = mapped_column(String(15))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)


# Internal staff users with role-based access.
class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("mobile REGEXP '^[0-9]{10}$'", name="chk_users_mobile_10_digits"),
    )

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    mobile: Mapped[str] = mapped_column(String(15), unique=True, nullable=False)
    center_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("centers.id"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    last_login: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    # Relationship to roles via user_roles junction table
    roles: Mapped[list["Role"]] = relationship("Role", secondary="user_roles", back_populates="users", lazy="selectin")


# RBAC: Roles table
class Role(Base):
    __tablename__ = "roles"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    # Relationships
    users: Mapped[list["User"]] = relationship("User", secondary="user_roles", back_populates="roles", lazy="selectin")
    permissions: Mapped[list["Permission"]] = relationship("Permission", secondary="role_permissions", back_populates="roles", lazy="selectin")


# RBAC: Permissions table
class Permission(Base):
    __tablename__ = "permissions"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    action: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    # Relationship to roles via role_permissions junction table
    roles: Mapped[list["Role"]] = relationship("Role", secondary="role_permissions", back_populates="permissions", lazy="selectin")


# RBAC: User-Role junction table
class UserRole(Base):
    __tablename__ = "user_roles"

    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id"), primary_key=True)
    role_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("roles.id"), primary_key=True)


# RBAC: Role-Permission junction table
class RolePermission(Base):
    __tablename__ = "role_permissions"

    role_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("roles.id"), primary_key=True)
    permission_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("permissions.id"), primary_key=True)


# OTP Sessions for authentication
class OTPSession(Base):
    __tablename__ = "otp_sessions"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    mobile: Mapped[str] = mapped_column(String(15), nullable=False)
    otp_code: Mapped[str] = mapped_column(String(255), nullable=False)
    purpose: Mapped[str] = mapped_column(String(50), default="login", nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    is_used: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    attempts: Mapped[int] = mapped_column(default=0, nullable=False)
    user_agent: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)


# Refresh Tokens for JWT authentication
class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id"), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    token_prefix: Mapped[str] = mapped_column(String(8), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    user: Mapped["User"] = relationship("User")


# SMS delivery log for OTP and future transactional events.
class NotificationLog(Base):
    __tablename__ = "notifications_log"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    recipient_mobile: Mapped[str] = mapped_column(String(20), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str | None] = mapped_column(String(100))
    reference_id: Mapped[str | None] = mapped_column(CHAR(36))
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text)
    sent_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)


# SMS template registry keyed by business event name.
class SMSTemplate(Base):
    __tablename__ = "sms_templates"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    event_name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    template_text: Mapped[str] = mapped_column(Text, nullable=False)
    template_id: Mapped[str | None] = mapped_column(String(100))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)


# Device master catalog (SKU-level metadata).
class SKU(Base):
    __tablename__ = "skus"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    sku_code: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(String(100))
    image_url: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)


# Physical tracked units (serial-level assets).
class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    sku_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("skus.id"), nullable=False)
    serial_number: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    center_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("centers.id"))
    home_center_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("centers.id"))
    status: Mapped[str] = mapped_column(String(30), default="available", nullable=False)
    purchase_date: Mapped[Date | None] = mapped_column(Date)
    warranty_expiry: Mapped[Date | None] = mapped_column(Date)
    invoice_number: Mapped[str | None] = mapped_column(String(100))
    invoice_url: Mapped[str | None] = mapped_column(Text)
    qr_code: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    sku: Mapped[SKU] = relationship("SKU")
    center: Mapped[Center | None] = relationship("Center", foreign_keys=[center_id])
    home_center: Mapped[Center | None] = relationship("Center", foreign_keys=[home_center_id])


# Public lease request/token header.
class LeaseRequest(Base):
    __tablename__ = "lease_requests"
    __table_args__ = (
        CheckConstraint("mobile REGEXP '^[0-9]{10}$'", name="chk_lease_mobile_10_digits"),
        CheckConstraint("aadhar_number REGEXP '^[0-9]{12}$'", name="chk_lease_aadhar_12_digits"),
    )

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    token_number: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    requestor_name: Mapped[str] = mapped_column(String(150), nullable=False)
    mobile: Mapped[str] = mapped_column(String(15), nullable=False)
    aadhar_number: Mapped[str] = mapped_column(String(20), nullable=False)
    patient_name: Mapped[str | None] = mapped_column(String(150), nullable=True)
    delivery_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    delivery_landmark: Mapped[str | None] = mapped_column(String(255), nullable=True)
    reference_name: Mapped[str | None] = mapped_column(String(150))
    preferred_center_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("centers.id"))
    expected_duration: Mapped[str | None] = mapped_column(String(50))
    due_date: Mapped[Date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    approval_comments: Mapped[str | None] = mapped_column(Text)
    rejection_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )

    preferred_center: Mapped[Center | None] = relationship("Center")


# Line items under a lease request (one row per SKU line).
class LeaseItem(Base):
    __tablename__ = "lease_items"
    __table_args__ = (
        CheckConstraint("quantity_requested > 0", name="chk_qty_requested"),
        CheckConstraint("approved_quantity IS NULL OR approved_quantity >= 0", name="chk_qty_approved"),
    )

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    lease_request_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("lease_requests.id"), nullable=False)
    sku_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("skus.id"), nullable=False)
    asset_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("assets.id"))
    quantity_requested: Mapped[int] = mapped_column(default=1, nullable=False)
    approved_quantity: Mapped[int | None] = mapped_column()
    issued_at: Mapped[datetime | None] = mapped_column(DateTime)
    issued_by: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("users.id"))
    due_date: Mapped[Date | None] = mapped_column(Date)
    returned_at: Mapped[datetime | None] = mapped_column(DateTime)
    returned_to: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("users.id"))
    return_center_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("centers.id"))
    condition_on_return: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    lease_request: Mapped[LeaseRequest] = relationship("LeaseRequest")
    sku: Mapped[SKU] = relationship("SKU")


# Public lease extension requests reviewed by staff.
class LeaseExtension(Base):
    __tablename__ = "lease_extensions"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    lease_request_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("lease_requests.id"), nullable=False)
    token_number: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    requested_duration: Mapped[str] = mapped_column(String(50), nullable=False)
    requested_days: Mapped[int] = mapped_column(nullable=False)
    requested_due_date: Mapped[Date | None] = mapped_column(Date)
    reason: Mapped[str | None] = mapped_column(Text)
    requestor_name: Mapped[str] = mapped_column(String(150), nullable=False)
    mobile: Mapped[str] = mapped_column(String(15), nullable=False)
    aadhar_number: Mapped[str] = mapped_column(String(20), nullable=False)
    current_due_date: Mapped[Date] = mapped_column(Date, nullable=False)
    approved_due_date: Mapped[Date | None] = mapped_column(Date)
    approver_comments: Mapped[str | None] = mapped_column(Text)
    rejection_reason: Mapped[str | None] = mapped_column(Text)
    requested_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime)
    reviewed_by: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("users.id"))

    lease_request: Mapped[LeaseRequest] = relationship("LeaseRequest")
    reviewer: Mapped["User | None"] = relationship("User")


# Immutable audit ledger for activity tracking.
class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("users.id"))
    center_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("centers.id"))
    action: Mapped[str] = mapped_column(String(100), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(50), nullable=False)
    entity_id: Mapped[str | None] = mapped_column(CHAR(36))
    old_value: Mapped[dict | None] = mapped_column(JSON)
    new_value: Mapped[dict | None] = mapped_column(JSON)
    ip_address: Mapped[str | None] = mapped_column(String(45))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)


class SKUBlock(Base):
    __tablename__ = "sku_blocks"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    lease_request_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("lease_requests.id"), nullable=False)
    sku_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("skus.id"), nullable=False)
    center_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("centers.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="blocked", nullable=False)
    release_reason: Mapped[str | None] = mapped_column(String(50), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)
    release_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
