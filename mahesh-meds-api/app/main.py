import os
import re
import secrets
import bcrypt
import jwt
import logging
import traceback
from datetime import date, datetime, UTC, timedelta
from decimal import Decimal
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, Cookie, Header
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.exc import IntegrityError
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session, joinedload

# Configure logging
IS_PRODUCTION = os.getenv("ENVIRONMENT", "development") == "production"
log_level = logging.WARNING if IS_PRODUCTION else logging.INFO
logging.basicConfig(
    level=log_level,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

logger = logging.getLogger(__name__)

from app.database import get_db, SessionLocal
from app.models import (
    Asset, AuditLog, Center, LeaseExtension, LeaseItem, LeaseRequest,
    SKU, User, OTPSession, RefreshToken, Role
)
from app.schemas import ( # Importing the schemas from the schemas.py file
    AssetCreate,
    AssetOwnershipUpdate,
    AssetOut,
    AssetUpdate,
    AuditLogOut,
    CenterCreate,
    CenterOut,
    LeaseExtensionCreate,
    LeaseExtensionOut,
    LeaseFulfillmentCenterOut,
    LeaseExtensionReview,
    LeaseRequestCreate,
    LeaseRequestListOut,
    PublicLeaseRequestOut,
    LeaseRequestOut,
    LeaseRequestUpdate,
    SKUCreate,
    SKUOut,
    SKUUpdate,
    UserCreate,
    UserOut,
    UserUpdate,
)
from app.scheduler import start_scheduler, stop_scheduler
from app.services.sms import SMS_ENABLED, send_template_sms

# -----------------------------------------------------------------------------
# API route map (backend endpoint -> frontend usage)
#
# Health:
# - GET /health
#   Used by: deployment/runtime health checks.
#
# Audit:
# - GET /api/v1/audit-logs
#   Used by: admin Activity Ledger (Reports page).
#
# Centers:
# - GET /api/v1/centers
#   Used by: public request form, admin pages, center scope dropdowns.
# - POST /api/v1/centers
#   Used by: admin Centers page (create center).
#
# Users:
# - GET /api/v1/users
#   Used by: login validation, admin Users page, center dashboard manager list.
# - POST /api/v1/users
#   Used by: admin Users page (create user).
# - PATCH /api/v1/users/{user_id}
#   Used by: admin Users page (edit role/center/active state).
# - DELETE /api/v1/users/{user_id}
#   Used by: admin Users page (remove user).
#
# SKUs:
# - GET /api/v1/skus
#   Used by: public request form, inventory/admin pages.
# - POST /api/v1/skus
#   Used by: admin SKU/center stock creation flows.
# - PATCH /api/v1/skus/{sku_id}
#   Used by: admin center inventory "Edit SKU / Add Stock".
#
# Assets:
# - GET /api/v1/assets
#   Used by: dashboards, issue/return workflows, asset listing.
# - POST /api/v1/assets
#   Used by: admin inventory stock creation and asset onboarding.
# - PATCH /api/v1/assets/{asset_id}
#   Used by: issue/return status and center updates.
#
# Lease requests:
# - GET /api/v1/lease-requests
#   Used by: admin/approver/center request list pages.
# - POST /api/v1/lease-requests
#   Used by: public Lease Request form submit.
# - PATCH /api/v1/lease-requests/{lease_id}
#   Used by: approver decisions, issue/return status transitions, item edits.
# - GET /api/v1/lease-requests/by-token/{token}
#   Used by: public status page and center return/issue flow (token lookup).
# - GET /api/v1/lease-requests/by-mobile/{mobile}
#   Used by: public status page when requestor tracks via mobile number.
# - GET /api/v1/lease-requests/by-token/{token}/issue-context/{center_id}
#   Used by: center Issue Device page for per-line availability planning.
# -----------------------------------------------------------------------------

app = FastAPI(title="Mahesh Meds API", version="0.2.0")


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    # Log the full traceback internally
    logger.error(
        f"Unhandled exception on "
        f"{request.method} {request.url}: "
        f"{traceback.format_exc()}"
    )
    # Return a clean response to the client
    return JSONResponse(
        status_code=500,
        content={
            "detail": "An unexpected error occurred. "
                      "Please try again or contact support."
        }
    )


@app.exception_handler(404)
async def not_found_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=404,
        content={"detail": "The requested resource was not found."}
    )


DEBUG_MODE = os.getenv("DEBUG", "false").lower() in ("true", "1", "yes")

# CORS setup: local defaults only apply in DEBUG mode. Production should set
# CORS_ORIGINS explicitly when the frontend is on a different origin.
DEFAULT_CORS_ORIGINS = ["http://localhost:8080", "http://127.0.0.1:8080"]
cors_origins_env = os.getenv(
    "CORS_ORIGINS",
    ",".join(DEFAULT_CORS_ORIGINS) if DEBUG_MODE else "",
)
cors_origins = [origin.strip() for origin in cors_origins_env.split(",") if origin.strip()]
if DEBUG_MODE and not cors_origins:
    cors_origins = DEFAULT_CORS_ORIGINS
default_local_origin_regex = (
    r"^https?://("
    r"localhost|127\.0\.0\.1|"
    r"10(?:\.\d{1,3}){3}|"
    r"192\.168(?:\.\d{1,3}){2}|"
    r"172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}"
    r")(?::\d+)?$"
)
cors_origin_regex = os.getenv(
    "CORS_ORIGIN_REGEX",
    default_local_origin_regex if DEBUG_MODE else "",
) or None
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_origin_regex=cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    start_scheduler()

    # Bootstrap master admin user from env variables if configured
    bootstrap_admin_mobile = os.getenv("BOOTSTRAP_ADMIN_MOBILE")
    bootstrap_admin_name = os.getenv("BOOTSTRAP_ADMIN_NAME", "System Admin")
    if bootstrap_admin_mobile:
        # Validate that mobile is exactly 10 digits as required by database constraints
        if not re.match(r"^[0-9]{10}$", bootstrap_admin_mobile):
            logger.error("Cannot bootstrap admin: BOOTSTRAP_ADMIN_MOBILE must be exactly 10 digits.")
            return

        db = SessionLocal()
        try:
            # Check if user already exists
            user = db.query(User).filter(User.mobile == bootstrap_admin_mobile).first()
            if not user:
                # Find the master_admin role
                admin_role = db.query(Role).filter(Role.name == "master_admin").first()
                if not admin_role:
                    logger.error("Cannot bootstrap admin: 'master_admin' role not found in database.")
                else:
                    logger.info("Bootstrapping master admin user with mobile %s", bootstrap_admin_mobile)
                    new_admin = User(
                        name=bootstrap_admin_name,
                        mobile=bootstrap_admin_mobile,
                        center_id=None,
                        is_active=True
                    )
                    new_admin.roles.append(admin_role)
                    db.add(new_admin)
                    db.commit()
                    logger.info("Successfully bootstrapped master admin user: %s", bootstrap_admin_name)
        except Exception as e:
            db.rollback()
            logger.exception("Failed to bootstrap master admin user: %s", e)
        finally:
            db.close()


@app.on_event("shutdown")
def _shutdown_scheduler() -> None:
    stop_scheduler()

ALLOWED_USER_ROLES = {"master_admin", "approver", "center_manager", "asset_manager"}

# --- JWT Configuration ---
JWT_SECRET = os.getenv("JWT_SECRET")
if not JWT_SECRET or len(JWT_SECRET) < 32:
    raise RuntimeError(
        "JWT_SECRET must be at least 32 "
        "characters. Generate one with: "
        "python -c 'import secrets; "
        "print(secrets.token_hex(32))'"
    )
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 15
REFRESH_TOKEN_EXPIRE_DAYS = 7
OTP_EXPIRE_MINUTES = 5
OTP_COOLDOWN_SECONDS = 60
MAX_OTP_ATTEMPTS = 5
OTP_PURPOSES = {"login"}

COOKIE_DOMAIN = os.getenv("COOKIE_DOMAIN", None)  # Set for production (e.g., ".maheshfoundation.org")
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false" if DEBUG_MODE else "true").lower() in ("true", "1", "yes")
COOKIE_SAMESITE = os.getenv("COOKIE_SAMESITE", "lax").lower()
if COOKIE_SAMESITE not in {"lax", "strict", "none"}:
    COOKIE_SAMESITE = "lax"
if COOKIE_SAMESITE == "none" and not COOKIE_SECURE:
    if DEBUG_MODE:
        COOKIE_SAMESITE = "lax"
    else:
        raise RuntimeError("COOKIE_SECURE=true is required when COOKIE_SAMESITE=none")


def auth_cookie_options() -> dict:
    """Shared options for HttpOnly auth cookies."""
    return {
        "httponly": True,
        "secure": COOKIE_SECURE,
        "samesite": COOKIE_SAMESITE,
        "domain": COOKIE_DOMAIN,
        "path": "/",
    }


def csrf_cookie_options() -> dict:
    """Shared options for readable CSRF cookie."""
    return {
        "httponly": False,
        "secure": COOKIE_SECURE,
        "samesite": COOKIE_SAMESITE,
        "domain": COOKIE_DOMAIN,
        "path": "/",
    }


def generate_asset_serial(db: Session, sku_id: str) -> str:
    """Generates the next unique serial number for a SKU."""
    sku = db.get(SKU, sku_id)
    if not sku:
        raise HTTPException(status_code=400, detail="Invalid sku_id")

    code_seed = "".join(ch for ch in sku.sku_code.upper() if ch.isalnum()) or "ASSET"
    next_sequence = (db.query(func.count(Asset.id)).filter(Asset.sku_id == sku_id).scalar() or 0) + 1

    while True:
        serial_number = f"{code_seed}-{next_sequence:04d}"
        exists = db.query(Asset.id).filter(Asset.serial_number == serial_number).first()
        if not exists:
            return serial_number
        next_sequence += 1


def create_access_token(user_id: str) -> str:
    """Create a JWT access token with user_id and expiration."""
    expire = datetime.now(UTC) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"user_id": user_id, "exp": expire, "type": "access"}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict | None:
    """Decode and validate a JWT access token."""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        if payload.get("type") != "access":
            return None
        return payload
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


def generate_refresh_token() -> str:
    """Generate a cryptographically secure opaque refresh token."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """Hash a token using bcrypt for secure storage."""
    return bcrypt.hashpw(token.encode(), bcrypt.gensalt()).decode()


def verify_token_hash(token: str, token_hash: str) -> bool:
    """Verify a token against its stored bcrypt hash."""
    return bcrypt.checkpw(token.encode(), token_hash.encode())


def hash_otp(otp: str) -> str:
    """Hash an OTP using bcrypt for secure storage."""
    return bcrypt.hashpw(otp.encode(), bcrypt.gensalt()).decode()


def verify_otp_hash(otp: str, otp_hash: str) -> bool:
    """Verify an OTP against its stored bcrypt hash."""
    return bcrypt.checkpw(otp.encode(), otp_hash.encode())


def generate_otp() -> str:
    """Generate a 6-digit OTP."""
    return f"{secrets.randbelow(900000) + 100000:06d}"


def generate_csrf_token() -> str:
    """Generate a CSRF token for double-submit cookie pattern."""
    return secrets.token_urlsafe(32)


# =============================================================================
# RBAC DEPENDENCIES
# =============================================================================

from typing import Callable
import time

# In-memory permission cache: {user_id: (permissions_set, timestamp)}
_permission_cache: dict[str, tuple[set[str], float]] = {}
PERMISSION_CACHE_TTL = 60  # seconds
PERMISSION_CATALOG: dict[str, str] = {
    "users.manage": "Create, update, disable, and review staff users.",
    "roles.manage": "Create and manage role/permission definitions.",
    "assets.create": "Create new assets in the system.",
    "assets.update": "Update asset details, status, soft delete, and ownership assignments.",
    "skus.manage": "Create, update, and soft delete SKUs.",
    "centers.manage": "Create and soft delete centers.",
    "requests.approve": "Approve lease requests.",
    "requests.reject": "Reject lease requests.",
    "requests.edit": "Edit lease requests and fulfillment notes.",
    "devices.issue": "Assign issued devices to approved requests.",
    "devices.collect": "Record returns and closure of issued devices.",
    "audit.view": "View audit logs and operational activity history.",
}


def get_current_user(
    db: Session = Depends(get_db),
    access_token: str = Cookie(None)
) -> User:
    """
    Dependency: Reads access_token from cookie, decodes and verifies JWT.
    Returns user object or raises 401.
    """
    if not access_token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    payload = decode_access_token(access_token)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    user_id = payload.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    user = db.query(User).options(
        joinedload(User.roles).joinedload(Role.permissions)
    ).filter(User.id == user_id, User.is_active == True).first()

    if not user:
        raise HTTPException(status_code=401, detail="User not found or inactive")

    return user


def _get_user_permissions(user: User) -> set[str]:
    """Extract all permissions from user's roles."""
    permissions = set()
    for role in user.roles:
        for perm in role.permissions:
            permissions.add(perm.action)
    return permissions


def _get_cached_permissions(user_id: str, db: Session) -> set[str] | None:
    """Get permissions from cache if valid, otherwise None."""
    cached = _permission_cache.get(user_id)
    if cached:
        permissions, timestamp = cached
        if time.time() - timestamp < PERMISSION_CACHE_TTL:
            return permissions
    return None


def _cache_permissions(user_id: str, permissions: set[str]) -> None:
    """Cache permissions for user."""
    _permission_cache[user_id] = (permissions, time.time())


def get_effective_permissions(current_user: User, db: Session) -> set[str]:
    """Resolve permissions from cache or the user's DB-loaded roles."""
    cached_perms = _get_cached_permissions(current_user.id, db)
    if cached_perms is not None:
        return cached_perms

    permissions = _get_user_permissions(current_user)
    _cache_permissions(current_user.id, permissions)
    return permissions


def require_permission(action: str) -> Callable:
    """
    Dependency factory: Creates a dependency that checks if user has the required permission.
    Caches permissions in-memory with 60-second TTL.

    Usage: Depends(require_permission("assets.create"))
    """
    def checker(
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user)
    ) -> User:
        permissions = get_effective_permissions(current_user, db)

        if action not in permissions:
            raise HTTPException(status_code=403, detail=f"Permission denied: {action}")

        return current_user
    return checker


def require_any_permission(*actions: str) -> Callable:
    """Dependency factory that allows any one of the provided permissions."""
    def checker(
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user)
    ) -> User:
        permissions = get_effective_permissions(current_user, db)
        if not permissions.intersection(actions):
            raise HTTPException(
                status_code=403,
                detail=f"Permission denied: one of {', '.join(actions)} required",
            )
        return current_user
    return checker


def active_users_with_permission(action: str, db: Session) -> list[User]:
    users = (
        db.query(User)
        .options(joinedload(User.roles).joinedload(Role.permissions))
        .filter(User.is_active == True)
        .all()
    )
    return [user for user in users if action in _get_user_permissions(user)]


def active_users_with_role(role_name: str, db: Session, *, center_id: str | None = None) -> list[User]:
    users = db.query(User).options(joinedload(User.roles)).filter(User.is_active == True)
    if center_id is not None:
        users = users.filter(User.center_id == center_id)
    rows = users.all()
    return [user for user in rows if any(role.name == role_name for role in user.roles)]


CENTER_SCOPED_OPERATIONAL_PERMISSIONS = {
    "assets.update",
    "devices.issue",
    "devices.collect",
}


def is_center_scoped_operator(current_user: User, db: Session) -> bool:
    """True for center-bound operational users like center managers."""
    if not current_user.center_id:
        return False
    permissions = get_effective_permissions(current_user, db)
    return bool(permissions) and permissions.issubset(CENTER_SCOPED_OPERATIONAL_PERMISSIONS)


def enforce_center_resource_access(
    current_user: User,
    db: Session,
    *resource_center_ids: str | None,
) -> None:
    """Restrict center-scoped operators to records touching their assigned center."""
    if not is_center_scoped_operator(current_user, db):
        return

    user_center_id = current_user.center_id
    if not user_center_id:
        raise HTTPException(status_code=403, detail="User has no center assignment")

    normalized_ids = {center_id for center_id in resource_center_ids if center_id}
    if normalized_ids and user_center_id not in normalized_ids:
        raise HTTPException(status_code=403, detail="Resource does not belong to your center")


def enforce_user_self_management_rules(
    current_user: User,
    target_user_id: str,
    *,
    is_active: bool | None = None,
    role_names: list[str] | None = None,
) -> None:
    """Prevent staff admins from locking themselves out via user-management endpoints."""
    if current_user.id != target_user_id:
        return

    if is_active is False:
        raise HTTPException(status_code=400, detail="You cannot deactivate your own account")

    if role_names is not None:
        raise HTTPException(status_code=400, detail="You cannot change your own roles")


def require_center_scope(
    resource_center_id: str | None = None,
    check_param: str | None = None
) -> Callable:
    """
    Dependency factory: Checks that the resource belongs to the user's center.
    Master Admin bypasses this check.

    Usage patterns:
    - For endpoints with center_id in path: Depends(require_center_scope(check_param="center_id"))
    - For endpoints with resource in DB: Depends(require_center_scope()) then manual check
    """
    def checker(
        current_user: User = Depends(get_current_user),
        **path_params
    ) -> User:
        # Master Admin bypass
        role_names = [role.name for role in current_user.roles]
        if "master_admin" in role_names:
            return current_user

        # Get user's center
        user_center_id = current_user.center_id
        if not user_center_id:
            raise HTTPException(status_code=403, detail="User has no center assignment")

        # Check against path param if specified
        if check_param and check_param in path_params:
            resource_center_id = path_params[check_param]

        if resource_center_id and resource_center_id != user_center_id:
            raise HTTPException(status_code=403, detail="Resource does not belong to your center")

        return current_user
    return checker


def invalidate_permission_cache(user_id: str) -> None:
    """Invalidate permission cache for a user (call when roles/permissions change)."""
    _permission_cache.pop(user_id, None)


def require_lease_permission(
    payload: LeaseRequestUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
) -> User:
    """
    Dependency for lease request PATCH that checks permission based on the action type.
    Maps payload actions to required permissions:
    - approve -> requests.approve
    - reject -> requests.reject
    - edit/items changes -> requests.edit
    - issue devices -> devices.issue
    - collect devices -> devices.collect
    """
    # Determine required permission based on payload
    required_permission = None

    if payload.status == "approved":
        required_permission = "requests.approve"
    elif payload.status == "rejected":
        required_permission = "requests.reject"
    elif payload.status == "closed":
        required_permission = "devices.collect"
    elif (
        payload.status == "active"
        and payload.notes is not None
        and payload.notes.startswith("Partial return:")
    ):
        required_permission = "devices.collect"
    elif payload.items is not None:
        # Items being edited (issuing/collecting devices)
        # Check if all items have asset_ids (issuing) or being removed (collecting)
        items = payload.items
        has_assets = any(item.asset_id for item in items)
        if has_assets:
            required_permission = "devices.issue"
        else:
            required_permission = "devices.collect"
    else:
        # Generic edit
        required_permission = "requests.edit"

    permissions = get_effective_permissions(current_user, db)

    if required_permission not in permissions:
        raise HTTPException(
            status_code=403,
            detail=f"Permission denied: {required_permission} required for this action"
        )

    return current_user


def require_requests_visibility(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
) -> User:
    """
    Dependency for lease request listing visibility.
    Allows only roles involved in request review or request fulfillment workflows.
    """
    allowed_permissions = {
        "requests.approve",
        "requests.reject",
        "requests.edit",
        "devices.issue",
        "devices.collect",
    }
    permissions = get_effective_permissions(current_user, db)
    if not permissions.intersection(allowed_permissions):
        raise HTTPException(status_code=403, detail="Permission denied: requests visibility")

    return current_user


def validate_csrf(
    csrf_token: str = Cookie(None, alias="csrf_token"),
    x_csrf_token: str | None = Header(None, alias="X-CSRF-Token"),
) -> None:
    """
    CSRF validation dependency for double-submit cookie pattern.
    Validates that the X-CSRF-Token header matches the csrf_token cookie.
    GET requests are exempt (don't use this dependency for GET endpoints).
    """
    if not csrf_token:
        raise HTTPException(status_code=403, detail="CSRF token cookie missing")

    if not x_csrf_token:
        raise HTTPException(status_code=403, detail="X-CSRF-Token header missing")

    # Use constant-time comparison to prevent timing attacks
    if not secrets.compare_digest(csrf_token, x_csrf_token):
        raise HTTPException(status_code=403, detail="CSRF token mismatch")


# =============================================================================
# Status mapping helpers (API <-> DB naming)
# =============================================================================
def asset_status_to_db(status: str) -> str:
    if status == "under_repair":
        return "repair"
    return status


def asset_status_to_api(status: str) -> str:
    if status == "repair":
        return "under_repair"
    return status


def lease_status_to_db(status: str) -> str:
    if status == "active":
        return "issued"
    if status == "closed":
        return "returned"
    return status


def lease_status_to_api(status: str) -> str:
    if status in {"issued", "partially_returned"}:
        return "active"
    if status == "returned":
        return "closed"
    return status


def resolve_lease_db_status(current_db_status: str, item_asset_ids: list[str | None]) -> str:
    """Server-authoritative fulfillment status derived from line-item assignment."""
    if current_db_status in {"rejected", "returned", "partially_returned"}:
        return current_db_status
    if item_asset_ids and all(item_asset_ids):
        return "issued"
    if current_db_status == "issued" and any(asset_id is None for asset_id in item_asset_ids):
        return "approved"
    return current_db_status


def parse_expected_duration_days(expected_duration: str | None) -> int | None:
    """Parse UI duration labels like '1 Week' into a day count."""
    if not expected_duration or not expected_duration.strip():
        return None

    lower = expected_duration.strip().lower()
    match = re.search(r"(\d+)", lower)
    if not match:
        return None

    value = int(match.group(1))
    if "week" in lower:
        return value * 7
    if "month" in lower:
        return value * 30
    if "day" in lower:
        return value
    return value


def compute_due_date(expected_duration: str | None, issued_at: datetime | None = None) -> date | None:
    """Derive a due date from expected duration and issue timestamp."""
    days = parse_expected_duration_days(expected_duration)
    if days is None:
        return None

    issue_date = (issued_at or datetime.now(UTC)).date()
    return issue_date + timedelta(days=days)


EXTENSION_DURATION_DAYS = {
    "3 days": 3,
    "1 week": 7,
    "2 weeks": 14,
    "1 month": 30,
}
ACTIVE_LEASE_DB_STATUSES = {"issued", "partially_returned"}


def parse_extension_duration_days(requested_duration: str) -> int | None:
    """Parse supported extension labels into a server-authoritative day count."""
    if not requested_duration or not requested_duration.strip():
        return None
    return EXTENSION_DURATION_DAYS.get(requested_duration.strip().lower())


def normalize_person_name(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").strip()).casefold()


def active_lease_items(db: Session, lease_request_id: str) -> list[LeaseItem]:
    return (
        db.query(LeaseItem)
        .filter(
            LeaseItem.lease_request_id == lease_request_id,
            LeaseItem.asset_id.is_not(None),
            LeaseItem.returned_at.is_(None),
        )
        .all()
    )


def ensure_lease_extension_schema(db: Session) -> None:
    if db.info.get("lease_extension_schema_ready"):
        return

    column_exists = db.execute(
        text(
            """
            SELECT COUNT(*)
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'lease_extensions'
              AND column_name = 'requested_due_date'
            """
        )
    ).scalar()
    if not column_exists:
        db.execute(text("ALTER TABLE lease_extensions ADD COLUMN requested_due_date DATE NULL"))
        db.commit()

    db.info["lease_extension_schema_ready"] = True


def latest_extension_summary(db: Session, lease_request_id: str) -> dict | None:
    ensure_lease_extension_schema(db)
    latest = (
        db.query(LeaseExtension)
        .filter(LeaseExtension.lease_request_id == lease_request_id)
        .order_by(LeaseExtension.requested_at.desc())
        .first()
    )
    if not latest:
        return None
    return {
        "id": latest.id,
        "status": latest.status,
        "requested_duration": latest.requested_duration,
        "requested_days": latest.requested_days,
        "requested_due_date": latest.requested_due_date,
        "current_due_date": latest.current_due_date,
        "approved_due_date": latest.approved_due_date,
        "requested_at": latest.requested_at,
        "reviewed_at": latest.reviewed_at,
        "reviewed_by": latest.reviewed_by,
    }


def extension_history_summary(db: Session, lease_request_id: str) -> list[dict]:
    ensure_lease_extension_schema(db)
    rows = (
        db.query(LeaseExtension)
        .filter(LeaseExtension.lease_request_id == lease_request_id)
        .order_by(LeaseExtension.requested_at.desc())
        .all()
    )
    return [
        {
            "id": row.id,
            "status": row.status,
            "requested_duration": row.requested_duration,
            "requested_days": row.requested_days,
            "requested_due_date": row.requested_due_date,
            "current_due_date": row.current_due_date,
            "approved_due_date": row.approved_due_date,
            "requested_at": row.requested_at,
            "reviewed_at": row.reviewed_at,
            "reviewed_by": row.reviewed_by,
            "reason": row.reason,
            "rejection_reason": row.rejection_reason,
        }
        for row in rows
    ]


def has_current_approved_extension(db: Session, lease: LeaseRequest) -> bool:
    ensure_lease_extension_schema(db)
    approved = (
        db.query(LeaseExtension)
        .filter(
            LeaseExtension.lease_request_id == lease.id,
            LeaseExtension.status == "approved",
            LeaseExtension.approved_due_date.is_not(None),
        )
        .order_by(LeaseExtension.reviewed_at.desc(), LeaseExtension.requested_at.desc())
        .first()
    )
    return bool(approved and lease.due_date and approved.approved_due_date == lease.due_date)


def evaluate_extension_eligibility(
    db: Session,
    lease: LeaseRequest,
    *,
    ignore_extension_id: str | None = None,
) -> tuple[bool, str, bool]:
    """
    Returns (eligible, reason, pending_exists) for public/staff lease extension flows.
    """
    ensure_lease_extension_schema(db)
    pending_query = db.query(LeaseExtension).filter(
        LeaseExtension.lease_request_id == lease.id,
        LeaseExtension.status == "pending",
    )
    if ignore_extension_id:
        pending_query = pending_query.filter(LeaseExtension.id != ignore_extension_id)
    pending_exists = pending_query.first() is not None
    if pending_exists:
        return False, "An extension request is already pending for this token.", True

    if has_current_approved_extension(db, lease):
        return False, "This lease has already been extended.", False

    if lease.status not in ACTIVE_LEASE_DB_STATUSES:
        return False, "Extensions are available only for active leases.", False

    if lease.due_date is None:
        return False, "This lease does not have a due date yet.", False

    active_items = active_lease_items(db, lease.id)
    if not active_items:
        return False, "All issued items on this lease have already been returned.", False

    today = datetime.now(UTC).date()
    if lease.due_date > today + timedelta(days=7):
        return False, "Extension requests open only within 7 days of the due date.", False

    if any(item.due_date is None for item in active_items):
        return False, "This lease has active items without persisted due dates.", False

    return True, "Eligible for extension request.", False


def require_extension_review_permission(payload: LeaseExtensionReview, current_user: User = Depends(get_current_user)) -> User:
    """Approvals require approve permission; rejections require reject permission."""
    requested_status = (payload.status or "").strip().lower()
    permissions = get_effective_permissions(current_user, db=None)
    if requested_status == "approved":
        if "requests.approve" not in permissions:
            raise HTTPException(status_code=403, detail="Permission denied: requests.approve")
    elif requested_status == "rejected":
        if "requests.reject" not in permissions:
            raise HTTPException(status_code=403, detail="Permission denied: requests.reject")
    else:
        raise HTTPException(status_code=400, detail="Invalid lease extension review status")
    return current_user


# --- Audit log classification and actor context helpers ---
def _section_for_log(entity_type: str, action: str) -> str:
    # Approver decisions should always appear in the approver section,
    # even when the entity type is lease_request.
    if action.startswith("approve_") or action.startswith("reject_") or entity_type in {"approval", "approver"}:
        return "approver"
    if entity_type in {"lease_request", "lease_item", "lease_extension", "token"}:
        return "requests"
    if entity_type in {"asset", "center"}:
        return "centers"
    if entity_type in {"admin", "user", "sku"}:
        return "admin"
    return "admin"


def _actor_context(
    db: Session,
    request: Request,
    current_user: User | None = None
) -> tuple[str | None, str | None, str | None]:
    """
    Extract actor context from verified JWT user or fall back to token from cookie.
    Returns: (user_id, role_string, mobile)
    """
    # If we have the verified user from JWT, use it directly
    if current_user:
        role_names = [role.name for role in current_user.roles]
        return current_user.id, ",".join(role_names), current_user.mobile

    # Fallback: try to decode JWT from cookie for non-dependent contexts
    access_token = request.cookies.get("access_token")
    if access_token:
        payload = decode_access_token(access_token)
        if payload and payload.get("user_id"):
            user_id = payload.get("user_id")
            user = db.query(User).filter(User.id == user_id).first()
            if user:
                role_names = [role.name for role in user.roles]
                return user.id, ",".join(role_names), user.mobile

    return None, None, None


def write_audit_log(
    db: Session,
    request: Request,
    action: str,
    entity_type: str,
    entity_id: str | None = None,
    center_id: str | None = None,
    old_value: dict | None = None,
    new_value: dict | None = None,
    current_user: User | None = None,
) -> None:
    def _json_safe(value):
        if isinstance(value, datetime):
            return value.isoformat()
        if isinstance(value, date):
            return value.isoformat()
        if isinstance(value, Decimal):
            return float(value)
        if isinstance(value, UUID):
            return str(value)
        if isinstance(value, dict):
            return {k: _json_safe(v) for k, v in value.items()}
        if isinstance(value, list):
            return [_json_safe(v) for v in value]
        if isinstance(value, tuple):
            return [_json_safe(v) for v in value]
        return value

    user_id, actor_role, actor_mobile = _actor_context(db, request, current_user)
    actor_meta: dict = {}
    if actor_mobile:
        actor_meta["actor_mobile"] = actor_mobile
    if actor_role:
        actor_meta["actor_role"] = actor_role
    enriched_new = _json_safe({**(new_value or {}), **actor_meta})
    safe_old = _json_safe(old_value)
    db.add(
        AuditLog(
            user_id=user_id,
            center_id=center_id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            old_value=safe_old,
            new_value=enriched_new,
            ip_address=request.client.host if request.client else None,
        )
    )


# --- Health and audit feed APIs ---
@app.get("/health")
def health_check():
    """Simple health probe used by deployments/monitoring."""
    return {"status": "ok"}


@app.get("/api/v1/audit-logs")
def list_audit_logs(
    section: str | None = Query(default=None),
    token: str | None = Query(default=None),
    start_at: str | None = Query(default=None),
    end_at: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("audit.view")),
):
    """Lists immutable activity logs with optional section/token/date filters."""
    query = db.query(AuditLog)
    if start_at:
        try:
            start_dt = datetime.fromisoformat(start_at.replace("Z", "+00:00")).replace(tzinfo=None)
            query = query.filter(AuditLog.created_at >= start_dt)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid start_at format; use ISO date") from None
    if end_at:
        try:
            end_dt = datetime.fromisoformat(end_at.replace("Z", "+00:00")).replace(tzinfo=None)
            if len(end_at) == 10:
                end_dt = end_dt + timedelta(days=1)
            query = query.filter(AuditLog.created_at <= end_dt)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid end_at format; use ISO date") from None

    logs = query.order_by(AuditLog.created_at.desc()).offset(offset).limit(limit).all()
    user_ids = [log.user_id for log in logs if log.user_id]
    center_ids = [log.center_id for log in logs if log.center_id]
    users = db.query(User).filter(User.id.in_(user_ids)).all() if user_ids else []
    centers = db.query(Center).filter(Center.id.in_(center_ids)).all() if center_ids else []
    user_name_by_id = {u.id: u.name for u in users}
    center_name_by_id = {c.id: c.name for c in centers}
    rows: list[dict] = []
    for log in logs:
        sec = _section_for_log(log.entity_type, log.action)
        if section and sec != section:
            continue
        token_value = (log.new_value or {}).get("token") or (log.old_value or {}).get("token")
        if token and token_value != token:
            continue
        rows.append(
            {
                **AuditLogOut.model_validate(log).model_dump(),
                "section": sec,
                "user_name": user_name_by_id.get(log.user_id) if log.user_id else None,
                "center_name": center_name_by_id.get(log.center_id) if log.center_id else None,
            }
        )
    return rows


@app.get("/api/v1/center/activity")
def list_center_activity(
    section: str | None = Query(default=None),
    center_id: str | None = Query(default=None),
    limit: int = Query(default=10, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Center-scoped recent activity feed for dashboard timelines."""
    requested_center_id = center_id or current_user.center_id
    if not requested_center_id:
        raise HTTPException(status_code=400, detail="No center scope available for this user")

    role_names = [role.name for role in current_user.roles]
    if "master_admin" not in role_names and current_user.center_id != requested_center_id:
        raise HTTPException(status_code=403, detail="Permission denied: center activity scope")

    query = (
        db.query(AuditLog)
        .filter(AuditLog.center_id == requested_center_id)
        .order_by(AuditLog.created_at.desc())
        .limit(limit)
    )
    logs = query.all()
    user_ids = [log.user_id for log in logs if log.user_id]
    users = db.query(User).filter(User.id.in_(user_ids)).all() if user_ids else []
    user_name_by_id = {u.id: u.name for u in users}

    rows: list[dict] = []
    for log in logs:
        sec = _section_for_log(log.entity_type, log.action)
        if section and sec != section:
            continue
        rows.append(
            {
                **AuditLogOut.model_validate(log).model_dump(),
                "section": sec,
                "user_name": user_name_by_id.get(log.user_id) if log.user_id else None,
                "center_name": None,
            }
        )
    return rows


# --- Center APIs ---
@app.get("/api/v1/centers", response_model=list[CenterOut])
def list_centers(
    include_inactive: bool = Query(default=False),
    db: Session = Depends(get_db),
):
    """Returns centers for admin/center scope selectors (public endpoint).
    By default, only active centers are returned."""
    query = db.query(Center)
    if not include_inactive:
        query = query.filter(Center.is_active == True)
    return query.order_by(Center.created_at.desc()).all()


@app.delete("/api/v1/centers/{center_id}")
def delete_center(
    center_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("centers.manage")),
    _: None = Depends(validate_csrf),
):
    """Soft deletes center by setting is_active=false."""
    center = db.get(Center, center_id)
    if not center:
        raise HTTPException(status_code=404, detail="Center not found")

    before = {"name": center.name, "is_active": center.is_active}

    # Soft delete: set is_active to false
    center.is_active = False
    db.commit()

    write_audit_log(
        db,
        request,
        action="center_deleted",
        entity_type="center",
        entity_id=center_id,
        center_id=center_id,
        old_value=before,
        new_value={"is_active": False},
        current_user=current_user,
    )
    db.commit()
    return {"status": "deleted"}


@app.post("/api/v1/centers", response_model=CenterOut)
def create_center(
    payload: CenterCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("centers.manage")),
    _: None = Depends(validate_csrf),
):
    """Creates a center record and writes audit event."""
    center = Center(**payload.model_dump())
    db.add(center)
    db.commit()
    db.refresh(center)
    write_audit_log(
        db,
        request,
        action="center_created",
        entity_type="center",
        entity_id=center.id,
        center_id=center.id,
        new_value={"name": center.name},
        current_user=current_user,
    )
    db.commit()
    return center


# --- User APIs ---
@app.get("/api/v1/users", response_model=list[UserOut])
def list_users(
    request: Request,
    include_inactive: bool = Query(default=False),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("users.manage")),
):
    """Returns users; used by admin user management and role checks.
    By default, only active users are returned."""
    query = db.query(User).options(joinedload(User.roles))
    if not include_inactive:
        query = query.filter(User.is_active == True)
    rows = query.order_by(User.created_at.desc()).all()
    write_audit_log(db, request, action="users_list_viewed", entity_type="admin", current_user=current_user)
    db.commit()
    # Transform roles for output
    result = []
    for user in rows:
        # Convert Role objects to string names BEFORE Pydantic validation
        role_names = [role.name for role in user.roles]
        # Create a dict with roles as strings for proper validation
        user_data = {
            "id": user.id,
            "name": user.name,
            "mobile": user.mobile,
            "is_active": user.is_active,
            "center_id": user.center_id,
            "last_login": user.last_login,
            "created_at": user.created_at,
            "roles": role_names
        }
        user_dict = UserOut.model_validate(user_data).model_dump()
        result.append(user_dict)
    return result


@app.post("/api/v1/users", response_model=UserOut)
def create_user(
    payload: UserCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("users.manage")),
    _: None = Depends(validate_csrf),
):
    """Creates a user after role and center validation. Assigns roles from payload."""
    if payload.center_id and not db.get(Center, payload.center_id):
        raise HTTPException(status_code=400, detail="Invalid center_id")

    # Extract roles from payload
    role_names = payload.roles or []
    user_data = payload.model_dump(exclude={"roles"})

    # Create user
    user = User(**user_data)
    db.add(user)
    db.flush()  # Get user.id without committing

    # Assign roles if provided
    if role_names:
        roles = db.query(Role).filter(Role.name.in_(role_names)).all()
        found_role_names = {r.name for r in roles}
        invalid_roles = set(role_names) - found_role_names
        if invalid_roles:
            db.rollback()
            raise HTTPException(status_code=400, detail=f"Invalid roles: {', '.join(invalid_roles)}")
        user.roles = roles

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Mobile already exists") from None

    db.refresh(user)
    write_audit_log(
        db,
        request,
        action="user_created",
        entity_type="admin",
        entity_id=user.id,
        center_id=user.center_id,
        new_value={"roles": role_names, "mobile": user.mobile, "name": user.name},
        current_user=current_user,
    )
    db.commit()

    # Return with roles - convert to strings BEFORE validation
    role_names_out = [role.name for role in user.roles]
    user_data = {
        "id": user.id,
        "name": user.name,
        "mobile": user.mobile,
        "is_active": user.is_active,
        "center_id": user.center_id,
        "last_login": user.last_login,
        "created_at": user.created_at,
        "roles": role_names_out
    }
    result = UserOut.model_validate(user_data).model_dump()
    return result


@app.patch("/api/v1/users/{user_id}", response_model=UserOut)
def update_user(
    user_id: str,
    payload: UserUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("users.manage")),
    _: None = Depends(validate_csrf),
):
    """Partially updates user profile/roles/status."""
    user = db.query(User).options(joinedload(User.roles)).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    before = {
        "name": user.name,
        "mobile": user.mobile,
        "center_id": user.center_id,
        "is_active": user.is_active,
        "roles": [role.name for role in user.roles],
    }

    data = payload.model_dump(exclude_unset=True)

    # Handle roles update separately
    new_roles = None
    if "roles" in data:
        role_names = data.pop("roles")
        if role_names is not None:
            roles = db.query(Role).filter(Role.name.in_(role_names)).all()
            found_role_names = {r.name for r in roles}
            invalid_roles = set(role_names) - found_role_names
            if invalid_roles:
                raise HTTPException(status_code=400, detail=f"Invalid roles: {', '.join(invalid_roles)}")
            new_roles = roles

    if "center_id" in data and data["center_id"] is not None and data["center_id"] and not db.get(Center, data["center_id"]):
        raise HTTPException(status_code=400, detail="Invalid center_id")

    enforce_user_self_management_rules(
        current_user,
        user.id,
        is_active=data.get("is_active"),
        role_names=[role.name for role in new_roles] if new_roles is not None else None,
    )

    # Update other fields
    for key, value in data.items():
        setattr(user, key, value)

    auth_context_changed = any(key in data for key in ("center_id", "is_active"))

    # Update roles if provided
    if new_roles is not None:
        user.roles = new_roles
        auth_context_changed = True

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Mobile already exists") from None

    if auth_context_changed:
        invalidate_permission_cache(user.id)

    db.refresh(user)

    new_value = {
        "name": user.name,
        "mobile": user.mobile,
        "center_id": user.center_id,
        "is_active": user.is_active,
        "roles": [role.name for role in user.roles],
    }

    write_audit_log(
        db,
        request,
        action="user_updated",
        entity_type="admin",
        entity_id=user.id,
        center_id=user.center_id,
        old_value=before,
        new_value=new_value,
        current_user=current_user,
    )
    db.commit()

    # Return with roles - convert to strings BEFORE validation
    role_names_out = [role.name for role in user.roles]
    user_data = {
        "id": user.id,
        "name": user.name,
        "mobile": user.mobile,
        "is_active": user.is_active,
        "center_id": user.center_id,
        "last_login": user.last_login,
        "created_at": user.created_at,
        "roles": role_names_out
    }
    result = UserOut.model_validate(user_data).model_dump()
    return result


@app.delete("/api/v1/users/{user_id}")
def delete_user(
    user_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("users.manage")),
    _: None = Depends(validate_csrf),
):
    """Soft deletes user by setting is_active=false."""
    user = db.query(User).options(joinedload(User.roles)).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    enforce_user_self_management_rules(current_user, user.id, is_active=False)

    before = {
        "name": user.name,
        "mobile": user.mobile,
        "center_id": user.center_id,
        "is_active": user.is_active,
        "roles": [role.name for role in user.roles],
    }

    # Soft delete: set is_active to false
    user.is_active = False
    db.commit()

    write_audit_log(
        db,
        request,
        action="user_deleted",
        entity_type="admin",
        entity_id=user_id,
        center_id=before.get("center_id"),
        old_value=before,
        new_value={"is_active": False},
        current_user=current_user,
    )
    db.commit()

    # Invalidate permission cache
    invalidate_permission_cache(user_id)

    return {"status": "deleted"}


# --- SKU APIs ---
@app.get("/api/v1/skus", response_model=list[SKUOut])
def list_skus(
    include_inactive: bool = Query(default=False),
    db: Session = Depends(get_db),
):
    """Returns SKU catalog (public endpoint).
    By default, only active SKUs are returned."""
    query = db.query(SKU)
    if not include_inactive:
        query = query.filter(SKU.is_active == True)
    return query.order_by(SKU.created_at.desc()).all()


@app.delete("/api/v1/skus/{sku_id}")
def delete_sku(
    sku_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("skus.manage")),
    _: None = Depends(validate_csrf),
):
    """Soft deletes SKU by setting is_active=false."""
    sku = db.get(SKU, sku_id)
    if not sku:
        raise HTTPException(status_code=404, detail="SKU not found")

    before = {"name": sku.name, "sku_code": sku.sku_code, "is_active": sku.is_active}

    # Soft delete: set is_active to false
    sku.is_active = False
    db.commit()

    write_audit_log(
        db,
        request,
        action="sku_deleted",
        entity_type="admin",
        entity_id=sku_id,
        old_value=before,
        new_value={"is_active": False},
        current_user=current_user,
    )
    db.commit()
    return {"status": "deleted"}


@app.post("/api/v1/skus", response_model=SKUOut)
def create_sku(
    payload: SKUCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("skus.manage")),
    _: None = Depends(validate_csrf),
):
    """Creates SKU metadata (code must be unique)."""
    sku = SKU(**payload.model_dump())
    db.add(sku)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="SKU code already exists") from None
    db.refresh(sku)
    write_audit_log(
        db, request, action="sku_created", entity_type="admin", entity_id=sku.id,
        new_value={"sku_code": sku.sku_code, "name": sku.name},
        current_user=current_user,
    )
    db.commit()
    return sku


@app.patch("/api/v1/skus/{sku_id}", response_model=SKUOut)
def update_sku(
    sku_id: str,
    payload: SKUUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("skus.manage")),
    _: None = Depends(validate_csrf),
):
    """Updates SKU metadata by id."""
    sku = db.get(SKU, sku_id)
    if not sku:
        raise HTTPException(status_code=404, detail="SKU not found")
    before = SKUOut.model_validate(sku).model_dump()
    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(sku, key, value)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="SKU code already exists") from None
    db.refresh(sku)
    write_audit_log(
        db, request, action="sku_updated", entity_type="admin", entity_id=sku.id,
        old_value=before, new_value=SKUOut.model_validate(sku).model_dump(),
        current_user=current_user,
    )
    db.commit()
    return sku


# --- Asset APIs ---
@app.get("/api/v1/assets", response_model=list[AssetOut])
def list_assets(
    request: Request,
    include_inactive: bool = Query(default=False),
    db: Session = Depends(get_db),
):
    """Returns physical assets with API-normalized status values (public endpoint).
    By default, only active assets are returned."""
    query = db.query(Asset)
    if not include_inactive:
        query = query.filter(Asset.is_active == True)
    assets = query.order_by(Asset.created_at.desc()).all()
    return [
        {
            **AssetOut.model_validate(asset).model_dump(),
            "status": asset_status_to_api(asset.status),
        }
        for asset in assets
    ]


@app.post("/api/v1/assets", response_model=AssetOut)
def create_asset(
    payload: AssetCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("assets.create")),
    _: None = Depends(validate_csrf),
):
    """Creates a serial-tracked asset after sku/center validation."""
    if not db.get(SKU, payload.sku_id):
        raise HTTPException(status_code=400, detail="Invalid sku_id")
    if payload.center_id and not db.get(Center, payload.center_id):
        raise HTTPException(status_code=400, detail="Invalid center_id")
    payload_data = payload.model_dump()
    if not payload_data.get("serial_number"):
        payload_data["serial_number"] = generate_asset_serial(db, payload.sku_id)
    payload_data["status"] = asset_status_to_db(payload_data["status"])
    # Auto-set home_center_id to center_id if not provided
    if not payload_data.get("home_center_id") and payload_data.get("center_id"):
        payload_data["home_center_id"] = payload_data["center_id"]
    asset = Asset(**payload_data)
    db.add(asset)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Serial number already exists") from None
    db.refresh(asset)
    write_audit_log(
        db,
        request,
        action="asset_created",
        entity_type="center",
        entity_id=asset.id,
        center_id=asset.center_id,
        new_value={"serial_number": asset.serial_number, "status": asset.status},
        current_user=current_user,
    )
    db.commit()
    return {
        **AssetOut.model_validate(asset).model_dump(),
        "status": asset_status_to_api(asset.status),
    }


@app.patch("/api/v1/assets/{asset_id}", response_model=AssetOut)
def update_asset(
    asset_id: str,
    payload: AssetUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("assets.update")),
    _: None = Depends(validate_csrf),
):
    """Updates asset status/center/notes."""
    asset = db.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    before = AssetOut.model_validate(asset).model_dump()
    data = payload.model_dump(exclude_unset=True)
    target_center_id = data.get("center_id", asset.center_id)
    enforce_center_resource_access(current_user, db, asset.center_id, target_center_id)
    if "status" in data and data["status"] is not None:
        data["status"] = asset_status_to_db(data["status"])
    if "center_id" in data and data["center_id"] is not None and data["center_id"] and not db.get(Center, data["center_id"]):
        raise HTTPException(status_code=400, detail="Invalid center_id")
    
    # Record return details in lease_items if asset was leased and is now being returned
    if asset.status == "leased" and data.get("status") in {"available", "repair"}:
        lease_item = db.query(LeaseItem).filter(
            LeaseItem.asset_id == asset.id,
            LeaseItem.returned_at.is_(None)
        ).first()
        if lease_item:
            lease_item.returned_at = datetime.now(UTC).replace(tzinfo=None)
            lease_item.returned_to = current_user.id
            lease_item.return_center_id = target_center_id or current_user.center_id
            lease_item.condition_on_return = data.get("notes")

    for key, value in data.items():
        setattr(asset, key, value)
    db.commit()
    db.refresh(asset)
    write_audit_log(
        db,
        request,
        action="asset_updated",
        entity_type="center",
        entity_id=asset.id,
        center_id=asset.center_id,
        old_value=before,
        new_value=AssetOut.model_validate(asset).model_dump(),
        current_user=current_user,
    )
    db.commit()
    return {
        **AssetOut.model_validate(asset).model_dump(),
        "status": asset_status_to_api(asset.status),
    }


@app.patch("/api/v1/assets/{asset_id}/ownership", response_model=AssetOut)
def update_asset_ownership(
    asset_id: str,
    payload: AssetOwnershipUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("assets.update")),
    _: None = Depends(validate_csrf),
):
    """Updates owning center explicitly; current location can optionally be aligned as well."""
    asset = db.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    if is_center_scoped_operator(current_user, db):
        raise HTTPException(status_code=403, detail="Ownership reassignment is not allowed for your access scope")

    if not db.get(Center, payload.home_center_id):
        raise HTTPException(status_code=400, detail="Invalid home_center_id")
    if payload.center_id is not None and payload.center_id and not db.get(Center, payload.center_id):
        raise HTTPException(status_code=400, detail="Invalid center_id")

    before = AssetOut.model_validate(asset).model_dump()
    asset.home_center_id = payload.home_center_id
    if payload.center_id is not None:
        asset.center_id = payload.center_id
    if payload.notes is not None:
        asset.notes = payload.notes

    db.commit()
    db.refresh(asset)
    write_audit_log(
        db,
        request,
        action="asset_ownership_updated",
        entity_type="center",
        entity_id=asset.id,
        center_id=asset.center_id,
        old_value=before,
        new_value=AssetOut.model_validate(asset).model_dump(),
        current_user=current_user,
    )
    db.commit()
    return {
        **AssetOut.model_validate(asset).model_dump(),
        "status": asset_status_to_api(asset.status),
    }


@app.delete("/api/v1/assets/{asset_id}")
def delete_asset(
    asset_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("assets.update")),
    _: None = Depends(validate_csrf),
):
    """Soft deletes asset by setting is_active=false."""
    asset = db.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    enforce_center_resource_access(current_user, db, asset.center_id)

    before = {
        "serial_number": asset.serial_number,
        "status": asset.status,
        "center_id": asset.center_id,
        "is_active": asset.is_active,
    }

    # Soft delete: set is_active to false
    asset.is_active = False
    db.commit()

    write_audit_log(
        db,
        request,
        action="asset_deleted",
        entity_type="center",
        entity_id=asset_id,
        center_id=asset.center_id,
        old_value=before,
        new_value={"is_active": False},
        current_user=current_user,
    )
    db.commit()
    return {"status": "deleted"}


# --- Lease request/token APIs ---
def normalize_public_tracking_mobile(mobile: str) -> str | None:
    """Normalize common Indian phone input formats to a 10-digit mobile number."""
    digits_only = re.sub(r"\D", "", mobile or "")
    if len(digits_only) == 12 and digits_only.startswith("91"):
        digits_only = digits_only[2:]
    elif len(digits_only) == 11 and digits_only.startswith("0"):
        digits_only = digits_only[1:]
    return digits_only if re.fullmatch(r"\d{10}", digits_only) else None


def build_fulfillment_plan(db: Session, lease_request_id: str) -> tuple[list[dict], str | None]:
    """Determine which centers can currently fulfill a request based on assigned assets and local stock."""
    item_rows = db.execute(
        select(
            LeaseItem.sku_id,
            SKU.name,
            LeaseItem.quantity_requested,
            LeaseItem.asset_id,
        )
        .join(SKU, SKU.id == LeaseItem.sku_id)
        .where(LeaseItem.lease_request_id == lease_request_id)
    ).all()
    if not item_rows:
        return [], None

    assigned_asset_ids = [asset_id for _, _, _, asset_id in item_rows if asset_id]
    assigned_assets: dict[str, Asset] = {}
    if assigned_asset_ids:
        assigned_assets = {
            asset.id: asset
            for asset in db.query(Asset).filter(Asset.id.in_(assigned_asset_ids)).all()
        }

    pending_sku_ids = list({sku_id for sku_id, _, _, asset_id in item_rows if not asset_id})
    availability_by_sku: dict[str, dict[str, int]] = {}
    if pending_sku_ids:
        availability_rows = db.execute(
            select(Asset.sku_id, Asset.center_id, func.count(Asset.id))
            .where(
                Asset.status == "available",
                Asset.sku_id.in_(pending_sku_ids),
                Asset.center_id.is_not(None),
            )
            .group_by(Asset.sku_id, Asset.center_id)
        ).all()
        for sku_id, center_id, count in availability_rows:
            if not center_id:
                continue
            availability_by_sku.setdefault(sku_id, {})[center_id] = int(count)

    center_name_by_id = {center.id: center.name for center in db.query(Center).all()}
    centers: dict[str, dict] = {}

    def add_center_assignment(center_id: str | None, sku_name: str, quantity: int) -> None:
        if not center_id:
            return
        bucket = centers.setdefault(
            center_id,
            {
                "center_id": center_id,
                "center_name": center_name_by_id.get(center_id, "Center"),
                "item_count": 0,
                "item_names": [],
            },
        )
        bucket["item_count"] += quantity
        if sku_name not in bucket["item_names"]:
            bucket["item_names"].append(sku_name)

    shortage_item_names: list[str] = []
    for sku_id, sku_name, quantity_requested, asset_id in item_rows:
        if asset_id:
            asset = assigned_assets.get(asset_id)
            lease_center_id = asset.home_center_id if asset and asset.home_center_id else asset.center_id if asset else None
            add_center_assignment(lease_center_id, sku_name, quantity_requested)
            continue

        remaining = quantity_requested
        center_counts = availability_by_sku.setdefault(sku_id, {})
        sorted_sources = sorted(
            center_counts.items(),
            key=lambda pair: (-pair[1], center_name_by_id.get(pair[0], "Center")),
        )
        for center_id, available_count in sorted_sources:
            if remaining <= 0:
                break
            take = min(remaining, available_count)
            if take <= 0:
                continue
            add_center_assignment(center_id, sku_name, take)
            center_counts[center_id] = max(0, center_counts[center_id] - take)
            remaining -= take

        if remaining > 0 and sku_name not in shortage_item_names:
            shortage_item_names.append(sku_name)

    fulfillment_centers = [
        LeaseFulfillmentCenterOut.model_validate(
            {
                **center_payload,
                "item_names": sorted(center_payload["item_names"]),
            }
        ).model_dump()
        for center_payload in sorted(centers.values(), key=lambda row: row["center_name"].lower())
    ]

    if not fulfillment_centers:
        fulfillment_message = None
    elif len(fulfillment_centers) == 1:
        fulfillment_message = f"Please visit {fulfillment_centers[0]['center_name']} with your Aadhaar to collect your approved device(s)."
    else:
        center_names = ", ".join(center["center_name"] for center in fulfillment_centers[:-1])
        center_names = (
            f"{center_names}, and {fulfillment_centers[-1]['center_name']}"
            if len(fulfillment_centers) > 2
            else f"{fulfillment_centers[0]['center_name']} and {fulfillment_centers[1]['center_name']}"
        )
        fulfillment_message = f"Please visit {center_names} with your Aadhaar to collect your approved device(s)."

    if shortage_item_names:
        shortage_text = ", ".join(shortage_item_names)
        fulfillment_message = (
            f"{fulfillment_message} Some item(s) are still awaiting stock: {shortage_text}."
            if fulfillment_message
            else f"Some item(s) are still awaiting stock: {shortage_text}."
        )

    return fulfillment_centers, fulfillment_message


def fulfillment_center_names(fulfillment_centers: list[dict]) -> str:
    """Render center names for SMS and UI copy."""
    names = [center["center_name"] for center in fulfillment_centers if center.get("center_name")]
    if not names:
        return "our centers"
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return f"{names[0]} and {names[1]}"
    return f"{', '.join(names[:-1])}, and {names[-1]}"


def build_public_lease_lookup_result(db: Session, req: LeaseRequest) -> dict:
    """Serialize a lease request with public tracking metadata and line items."""
    sku_rows = db.execute(
        select(
            LeaseItem.lease_request_id,
            LeaseItem.sku_id,
            SKU.name,
            LeaseItem.quantity_requested,
            LeaseItem.asset_id,
            LeaseItem.due_date,
        )
        .join(SKU, SKU.id == LeaseItem.sku_id)
        .where(LeaseItem.lease_request_id == req.id)
    ).all()
    skus = [name for _, _, name, _, _, _ in sku_rows]
    items = [
        {
            "sku_id": sku_id,
            "sku_name": name,
            "quantity_requested": quantity_requested,
            "asset_id": asset_id,
            "due_date": due_date,
        }
        for _, sku_id, name, quantity_requested, asset_id, due_date in sku_rows
    ]
    extension_eligible, extension_reason, pending_extension_request = evaluate_extension_eligibility(db, req)
    fulfillment_centers, fulfillment_message = build_fulfillment_plan(db, req.id)
    res = {
        **LeaseRequestOut.model_validate(req).model_dump(),
        "status": lease_status_to_api(req.status),
        "skus": skus,
        "items": items,
        "fulfillment_centers": fulfillment_centers,
        "fulfillment_message": fulfillment_message,
        "extension_eligible": extension_eligible,
        "extension_eligibility_reason": extension_reason,
        "pending_extension_request": pending_extension_request,
        "latest_extension": latest_extension_summary(db, req.id),
        "extension_history": extension_history_summary(db, req.id),
    }

    # Mask sensitive customer PII fields
    if res.get("mobile"):
        m = res["mobile"]
        res["mobile"] = m[:2] + "*" * (len(m) - 4) + m[-2:] if len(m) >= 4 else "*" * len(m)
    if res.get("aadhar_number"):
        a = res["aadhar_number"]
        res["aadhar_number"] = "*" * (len(a) - 4) + a[-4:] if len(a) >= 4 else "*" * len(a)

    return res


@app.get("/api/v1/lease-requests/by-token/{token}", response_model=PublicLeaseRequestOut)
def get_lease_request_by_token(token: str, request: Request, db: Session = Depends(get_db)):
    """Public token lookup endpoint with request header + line items."""
    req = (
        db.query(LeaseRequest)
        .filter(func.lower(LeaseRequest.token_number) == token.strip().lower())
        .first()
    )
    if not req:
        raise HTTPException(status_code=404, detail="Lease request not found")
    result = build_public_lease_lookup_result(db, req)
    write_audit_log(
        db,
        request,
        action="token_viewed",
        entity_type="token",
        entity_id=req.id,
        center_id=req.preferred_center_id,
        new_value={"token": req.token_number, "status": lease_status_to_api(req.status)},
    )
    db.commit()
    return result


@app.get("/api/v1/lease-requests/by-mobile/{mobile}", response_model=list[PublicLeaseRequestOut])
def get_lease_requests_by_mobile(mobile: str, request: Request, db: Session = Depends(get_db)):
    """Public mobile lookup endpoint returning all requests linked to that number."""
    normalized_mobile = normalize_public_tracking_mobile(mobile)
    if not normalized_mobile:
        raise HTTPException(status_code=400, detail="Enter a valid 10-digit mobile number")

    requests = (
        db.query(LeaseRequest)
        .filter(LeaseRequest.mobile == normalized_mobile)
        .order_by(LeaseRequest.created_at.desc())
        .all()
    )
    if not requests:
        raise HTTPException(status_code=404, detail="No lease requests found for this mobile number")

    results = [build_public_lease_lookup_result(db, lease_request) for lease_request in requests]
    write_audit_log(
        db,
        request,
        action="mobile_lookup_viewed",
        entity_type="token",
        entity_id=None,
        new_value={"mobile": normalized_mobile, "match_count": len(results)},
    )
    db.commit()
    return results


@app.post("/api/v1/lease-extensions", response_model=LeaseExtensionOut)
def create_lease_extension(
    payload: LeaseExtensionCreate,
    request: Request,
    db: Session = Depends(get_db),
):
    """Public lease extension request endpoint validated against the existing lease token."""
    lease = (
        db.query(LeaseRequest)
        .filter(func.lower(LeaseRequest.token_number) == payload.token_number.strip().lower())
        .first()
    )
    if not lease:
        raise HTTPException(status_code=404, detail="Lease request not found")

    if lease.mobile != payload.mobile:
        raise HTTPException(status_code=400, detail="Mobile number does not match this token")
    if lease.aadhar_number != payload.aadhar_number:
        raise HTTPException(status_code=400, detail="Aadhaar number does not match this token")
    if normalize_person_name(lease.requestor_name) != normalize_person_name(payload.requestor_name):
        raise HTTPException(status_code=400, detail="Requestor name does not match this token")

    if lease.due_date is None:
        raise HTTPException(status_code=400, detail="Cannot extend a lease without an existing due date")

    today = datetime.now(UTC).date()
    requested_due_date = payload.requested_due_date
    if requested_due_date <= lease.due_date:
        raise HTTPException(status_code=400, detail="Requested return date must be after the current due date")
    if requested_due_date <= today:
        raise HTTPException(status_code=400, detail="Requested return date must be in the future")

    requested_days = (requested_due_date - lease.due_date).days
    requested_duration = payload.requested_duration.strip() if payload.requested_duration and payload.requested_duration.strip() else f"{requested_days} Days"

    eligible, eligibility_reason, pending_exists = evaluate_extension_eligibility(db, lease)
    if not eligible:
        raise HTTPException(status_code=409 if pending_exists else 400, detail=eligibility_reason)

    extension = LeaseExtension(
        lease_request_id=lease.id,
        token_number=lease.token_number,
        status="pending",
        requested_duration=requested_duration,
        requested_days=requested_days,
        requested_due_date=requested_due_date,
        reason=payload.reason,
        requestor_name=payload.requestor_name.strip(),
        mobile=payload.mobile,
        aadhar_number=payload.aadhar_number,
        current_due_date=lease.due_date,
    )
    db.add(extension)
    db.commit()
    db.refresh(extension)

    write_audit_log(
        db,
        request,
        action="lease_extension_requested",
        entity_type="lease_extension",
        entity_id=extension.id,
        center_id=lease.preferred_center_id,
        new_value={
            "token": lease.token_number,
            "status": extension.status,
            "requested_duration": extension.requested_duration,
            "requested_days": extension.requested_days,
            "requested_due_date": extension.requested_due_date,
            "current_due_date": extension.current_due_date,
        },
    )
    db.commit()
    return extension


@app.get("/api/v1/lease-extensions", response_model=list[LeaseExtensionOut])
def list_lease_extensions(
    request: Request,
    status: str | None = Query(default=None),
    lease_request_id: str | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_any_permission("requests.approve", "requests.reject")),
):
    """Approver/staff queue for lease extension review."""
    query = db.query(LeaseExtension).join(LeaseRequest, LeaseRequest.id == LeaseExtension.lease_request_id)
    if status:
        query = query.filter(LeaseExtension.status == status.strip().lower())
    if lease_request_id:
        query = query.filter(LeaseExtension.lease_request_id == lease_request_id)
    if is_center_scoped_operator(current_user, db):
        query = query.filter(LeaseRequest.preferred_center_id == current_user.center_id)
    rows = query.order_by(LeaseExtension.requested_at.desc()).all()
    write_audit_log(
        db,
        request,
        action="lease_extensions_list_viewed",
        entity_type="lease_extension",
        current_user=current_user,
    )
    db.commit()
    return rows


@app.patch("/api/v1/lease-extensions/{extension_id}", response_model=LeaseExtensionOut)
def review_lease_extension(
    extension_id: str,
    payload: LeaseExtensionReview,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_extension_review_permission),
    _: None = Depends(validate_csrf),
):
    """Approve or reject a pending lease extension and update persisted due dates on approval."""
    extension = db.get(LeaseExtension, extension_id)
    if not extension:
        raise HTTPException(status_code=404, detail="Lease extension not found")
    if extension.status != "pending":
        raise HTTPException(status_code=400, detail="This extension request has already been reviewed")

    lease = db.get(LeaseRequest, extension.lease_request_id)
    if not lease:
        raise HTTPException(status_code=404, detail="Lease request not found")
    enforce_center_resource_access(current_user, db, lease.preferred_center_id)

    review_status = payload.status.strip().lower()
    before = LeaseExtensionOut.model_validate(extension).model_dump()
    extension.reviewed_at = datetime.now(UTC).replace(tzinfo=None)
    extension.reviewed_by = current_user.id

    if review_status == "approved":
        eligible, reason, _ = evaluate_extension_eligibility(db, lease, ignore_extension_id=extension.id)
        if not eligible:
            raise HTTPException(status_code=400, detail=reason)
        if lease.due_date is None:
            raise HTTPException(status_code=400, detail="Cannot extend a lease without an existing due date")

        new_due_date = extension.requested_due_date or (lease.due_date + timedelta(days=extension.requested_days))
        active_items = active_lease_items(db, lease.id)
        for item in active_items:
            item.due_date = new_due_date

        lease.due_date = new_due_date
        extension.status = "approved"
        extension.approved_due_date = new_due_date
        extension.approver_comments = payload.approver_comments
        extension.rejection_reason = None
    elif review_status == "rejected":
        if not payload.rejection_reason or len(payload.rejection_reason.strip()) < 10:
            raise HTTPException(status_code=400, detail="Rejection reason must be at least 10 characters")
        extension.status = "rejected"
        extension.rejection_reason = payload.rejection_reason.strip()
        extension.approver_comments = payload.approver_comments
        extension.approved_due_date = None
    else:
        raise HTTPException(status_code=400, detail="Invalid lease extension review status")

    db.commit()
    db.refresh(extension)

    write_audit_log(
        db,
        request,
        action="approve_lease_extension" if review_status == "approved" else "reject_lease_extension",
        entity_type="lease_extension",
        entity_id=extension.id,
        center_id=lease.preferred_center_id,
        old_value={**before, "token": extension.token_number},
        new_value={**LeaseExtensionOut.model_validate(extension).model_dump(), "token": extension.token_number},
        current_user=current_user,
    )
    db.commit()
    return extension


@app.get("/api/v1/lease-requests/by-token/{token}/issue-context/{center_id}")
def get_issue_context(
    token: str,
    center_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("devices.issue")),
):
    """Issue workflow helper: line-level availability at the queried center."""
    req = (
        db.query(LeaseRequest)
        .filter(func.lower(LeaseRequest.token_number) == token.strip().lower())
        .first()
    )
    if not req:
        raise HTTPException(status_code=404, detail="Lease request not found")
    if not db.get(Center, center_id):
        raise HTTPException(status_code=400, detail="Invalid center_id")
    enforce_center_resource_access(current_user, db, center_id)

    sku_rows = db.execute(
        select(
            LeaseItem.lease_request_id,
            LeaseItem.sku_id,
            SKU.name,
            LeaseItem.quantity_requested,
            LeaseItem.asset_id,
            LeaseItem.due_date,
        )
        .join(SKU, SKU.id == LeaseItem.sku_id)
        .where(LeaseItem.lease_request_id == req.id)
    ).all()
    skus = [name for _, _, name, _, _, _ in sku_rows]
    items = [
        {
            "sku_id": sku_id,
            "sku_name": name,
            "quantity_requested": quantity_requested,
            "asset_id": asset_id,
            "due_date": due_date,
        }
        for _, sku_id, name, quantity_requested, asset_id, due_date in sku_rows
    ]

    pending_sku_ids = [item["sku_id"] for item in items if not item["asset_id"]]
    availability_by_sku: dict[str, dict[str, int]] = {}
    if pending_sku_ids:
        availability_rows = db.execute(
            select(Asset.sku_id, Asset.center_id, func.count(Asset.id))
            .where(Asset.status == "available", Asset.sku_id.in_(pending_sku_ids), Asset.center_id.is_not(None))
            .group_by(Asset.sku_id, Asset.center_id)
        ).all()
        for sku_id, c_id, count in availability_rows:
            availability_by_sku.setdefault(sku_id, {})[c_id] = int(count)

    centers = db.query(Center).all()
    center_name_by_id = {c.id: c.name for c in centers}

    issue_items = []
    for item in items:
        sku_id = item["sku_id"]
        center_counts = availability_by_sku.get(sku_id, {})
        source_centers = [
            {"center_id": c_id, "center_name": center_name_by_id.get(c_id, "Center"), "available_count": count}
            for c_id, count in center_counts.items()
            if c_id != center_id and count > 0
        ]
        issue_items.append(
            {
                **item,
                "local_available_count": center_counts.get(center_id, 0),
                "source_centers": source_centers,
            }
        )

    write_audit_log(
        db,
        request,
        action="issue_context_viewed",
        entity_type="lease_request",
        entity_id=req.id,
        center_id=center_id,
        new_value={"token": req.token_number, "center_id": center_id},
        current_user=current_user,
    )
    db.commit()

    return {
        **LeaseRequestOut.model_validate(req).model_dump(),
        "status": lease_status_to_api(req.status),
        "skus": skus,
        "items": items,
        "issue_items": issue_items,
    }


@app.get("/api/v1/lease-requests", response_model=list[LeaseRequestListOut])
def list_lease_requests(
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_requests_visibility),
):
    """Lists lease requests with denormalized sku/item arrays for frontend tables."""
    query = db.query(LeaseRequest)
    # Center-specific relevance is now derived from actual asset location/home-center data.
    # if is_center_scoped_operator(current_user, db):
    #     query = query.filter(LeaseRequest.preferred_center_id == current_user.center_id)
    requests = query.order_by(LeaseRequest.created_at.desc()).all()
    write_audit_log(db, request, action="requests_list_viewed", entity_type="lease_request", current_user=current_user)
    db.commit()
    if not requests:
        return []

    request_ids = [r.id for r in requests]
    sku_rows = db.execute(
        select(
            LeaseItem.lease_request_id,
            LeaseItem.sku_id,
            SKU.name,
            LeaseItem.quantity_requested,
            LeaseItem.asset_id,
            LeaseItem.due_date,
        )
        .join(SKU, SKU.id == LeaseItem.sku_id)
        .where(LeaseItem.lease_request_id.in_(request_ids))
    ).all()

    sku_map: dict[str, list[str]] = {}
    item_map: dict[str, list[dict[str, str | int]]] = {}
    for lease_request_id, sku_id, sku_name, quantity_requested, asset_id, due_date in sku_rows:
        sku_map.setdefault(lease_request_id, []).append(sku_name)
        item_map.setdefault(lease_request_id, []).append(
            {
                "sku_id": sku_id,
                "sku_name": sku_name,
                "quantity_requested": quantity_requested,
                "asset_id": asset_id,
                "due_date": due_date,
            }
        )

    response_rows = []
    for req in requests:
        fulfillment_centers, fulfillment_message = build_fulfillment_plan(db, req.id)
        response_rows.append(
            {
                **LeaseRequestOut.model_validate(req).model_dump(),
                "status": lease_status_to_api(req.status),
                "skus": sku_map.get(req.id, []),
                "items": item_map.get(req.id, []),
                "fulfillment_centers": fulfillment_centers,
                "fulfillment_message": fulfillment_message,
            }
        )
    return response_rows


@app.post("/api/v1/lease-requests", response_model=LeaseRequestOut)
def create_lease_request(
    payload: LeaseRequestCreate,
    request: Request,
    db: Session = Depends(get_db),
):
    """Creates lease request + lease items and derives fulfillment-aware status (PUBLIC - no auth required)."""
    for item in payload.items:
        if not db.get(SKU, item.sku_id):
            raise HTTPException(status_code=400, detail=f"Invalid sku_id in items: {item.sku_id}")

    payload_data = payload.model_dump()
    items_payload = payload_data.pop("items", [])
    payload_data["status"] = lease_status_to_db(payload_data["status"])
    lease = LeaseRequest(**payload_data)
    db.add(lease)
    try:
        db.flush()
        for item in items_payload:
            db.add(
                LeaseItem(
                    lease_request_id=lease.id,
                    sku_id=item["sku_id"],
                    quantity_requested=item.get("quantity_requested", 1),
                    asset_id=item.get("asset_id"),
                )
            )
        lease.status = resolve_lease_db_status(
            lease.status,
            [item.get("asset_id") for item in items_payload],
        )
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Token number already exists") from None
    db.refresh(lease)
    write_audit_log(
        db,
        request,
        action="request_created",
        entity_type="lease_request",
        entity_id=lease.id,
        center_id=None,
        new_value={"token": lease.token_number, "status": lease_status_to_api(lease.status)},
    )
    db.commit()

    send_template_sms(
        mobile=lease.mobile,
        event_name="request_submitted_user",
        variables={"token_number": lease.token_number},
        db=db,
        reference_id=lease.id,
    )
    sku_ids = [item["sku_id"] for item in items_payload]
    skus = db.query(SKU).filter(SKU.id.in_(sku_ids)).all()
    items_str = ", ".join(sku.name for sku in skus) if skus else "N/A"
    for approver in active_users_with_permission("requests.approve", db):
        send_template_sms(
            mobile=approver.mobile,
            event_name="request_submitted_approver",
            variables={
                "requestor_name": lease.requestor_name,
                "items": items_str,
            },
            db=db,
            reference_id=lease.id,
        )

    return {
        **LeaseRequestOut.model_validate(lease).model_dump(),
        "status": lease_status_to_api(lease.status),
    }


@app.patch("/api/v1/lease-requests/{lease_id}", response_model=LeaseRequestOut)
def update_lease_request(
    lease_id: str,
    payload: LeaseRequestUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_lease_permission),
    _: None = Depends(validate_csrf),
):
    """Updates lease request header/items; status is re-derived from line assignments.
    Permission checked dynamically based on action type (approve/reject/edit/issue/collect)."""
    lease = db.get(LeaseRequest, lease_id)
    if not lease:
        raise HTTPException(status_code=404, detail="Lease request not found")
    before = LeaseRequestOut.model_validate(lease).model_dump()
    data = payload.model_dump(exclude_unset=True)
    items_payload = data.pop("items", None)
    existing_items = db.query(LeaseItem).filter(LeaseItem.lease_request_id == lease.id).all()
    resource_center_ids = {lease.preferred_center_id} if lease.preferred_center_id else set()
    relevant_asset_ids = {
        item.asset_id for item in existing_items if item.asset_id
    }
    if items_payload is not None:
        relevant_asset_ids.update(item.get("asset_id") for item in items_payload if item.get("asset_id"))
    if relevant_asset_ids:
        relevant_assets = db.query(Asset).filter(Asset.id.in_(relevant_asset_ids)).all()
        resource_center_ids.update(
            asset.home_center_id or asset.center_id
            for asset in relevant_assets
            if asset.home_center_id or asset.center_id
        )
    enforce_center_resource_access(current_user, db, *resource_center_ids)
    if items_payload is not None:
        for item in items_payload:
            if not db.get(SKU, item["sku_id"]):
                raise HTTPException(status_code=400, detail=f"Invalid sku_id in items: {item['sku_id']}")
    if "status" in data and data["status"] is not None:
        data["status"] = lease_status_to_db(data["status"])
    for key, value in data.items():
        setattr(lease, key, value)
    if items_payload is not None:
        existing_item_by_assignment = {
            (item.sku_id, item.asset_id): item
            for item in existing_items
            if item.asset_id
        }
        issued_at_now = datetime.now(UTC).replace(tzinfo=None)
        active_due_dates: list[date] = []
        db.query(LeaseItem).filter(LeaseItem.lease_request_id == lease.id).delete()
        for item in items_payload:
            asset_id = item.get("asset_id")
            previous_item = existing_item_by_assignment.get((item["sku_id"], asset_id)) if asset_id else None
            item_issued_at = previous_item.issued_at if previous_item else None
            item_due_date = previous_item.due_date if previous_item else None
            item_returned_at = previous_item.returned_at if previous_item else None
            item_returned_to = previous_item.returned_to if previous_item else None
            item_return_center_id = previous_item.return_center_id if previous_item else None
            item_condition_on_return = previous_item.condition_on_return if previous_item else None

            if asset_id and item_due_date is None:
                item_issued_at = issued_at_now
                item_due_date = compute_due_date(lease.expected_duration, item_issued_at)
            if asset_id and item_due_date:
                active_due_dates.append(item_due_date)
            db.add(
                LeaseItem(
                    lease_request_id=lease.id,
                    sku_id=item["sku_id"],
                    quantity_requested=item.get("quantity_requested", 1),
                    asset_id=asset_id,
                    issued_at=item_issued_at,
                    due_date=item_due_date,
                    returned_at=item_returned_at,
                    returned_to=item_returned_to,
                    return_center_id=item_return_center_id,
                    condition_on_return=item_condition_on_return,
                )
            )
        lease.status = resolve_lease_db_status(
            lease.status,
            [item.get("asset_id") for item in items_payload],
        )
        lease.due_date = max(active_due_dates) if active_due_dates else None
    elif lease.status not in {"rejected", "returned", "partially_returned"}:
        lease.status = resolve_lease_db_status(lease.status, [item.asset_id for item in existing_items])
        active_due_dates = [
            item.due_date
            for item in existing_items
            if item.asset_id and item.due_date and item.returned_at is None
        ]
        lease.due_date = max(active_due_dates) if active_due_dates else None
    db.commit()
    db.refresh(lease)
    action = "request_updated"
    if payload.status == "approved":
        action = "approve_request"
    elif payload.status == "rejected":
        action = "reject_request"
    write_audit_log(
        db,
        request,
        action=action,
        entity_type="lease_request",
        entity_id=lease.id,
        center_id=current_user.center_id,
        old_value={**before, "token": before.get("token_number")},
        new_value={**LeaseRequestOut.model_validate(lease).model_dump(), "token": lease.token_number},
        current_user=current_user,
    )
    db.commit()

    if payload.status == "approved":
        fulfillment_centers, fulfillment_message = build_fulfillment_plan(db, lease.id)
        send_template_sms(
            mobile=lease.mobile,
            event_name="request_approved_user",
            variables={
                "token_number": lease.token_number,
                "center_name": fulfillment_center_names(fulfillment_centers),
                "pickup_guidance": fulfillment_message or "Our team will contact you with pickup details.",
            },
            db=db,
            reference_id=lease.id,
        )
        for center in fulfillment_centers:
            for manager in active_users_with_role("center_manager", db, center_id=center["center_id"]):
                send_template_sms(
                    mobile=manager.mobile,
                    event_name="request_approved_center_manager",
                    variables={
                        "token_number": lease.token_number,
                        "requestor_name": lease.requestor_name,
                        "center_name": center["center_name"],
                    },
                    db=db,
                    reference_id=lease.id,
                )
    elif payload.status == "rejected":
        send_template_sms(
            mobile=lease.mobile,
            event_name="request_rejected_user",
            variables={
                "token_number": lease.token_number,
                "rejection_reason": lease.rejection_reason or "",
            },
            db=db,
            reference_id=lease.id,
        )

    if before.get("status") != "issued" and lease.status == "issued":
        db_items = db.query(LeaseItem).filter(LeaseItem.lease_request_id == lease.id).all()
        items_names = [item.sku.name for item in db_items if item.sku]
        items_str = ", ".join(items_names) if items_names else "N/A"
        due_date_str = lease.due_date.strftime("%B %d, %Y") if lease.due_date else "N/A"
        send_template_sms(
            mobile=lease.mobile,
            event_name="device_issued_user",
            variables={
                "token_number": lease.token_number,
                "items": items_str,
                "due_date": due_date_str,
            },
            db=db,
            reference_id=lease.id,
        )

    return {
        **LeaseRequestOut.model_validate(lease).model_dump(),
        "status": lease_status_to_api(lease.status),
    }


# =============================================================================
# AUTHENTICATION ENDPOINTS (OTP + JWT)
# =============================================================================

from pydantic import BaseModel


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


def audit_otp_event(
    db: Session,
    request: Request,
    action: str,
    mobile: str,
    *,
    entity_id: str | None = None,
    details: dict | None = None,
) -> None:
    """Writes OTP/auth-related audit events before raising or returning."""
    user = db.query(User).filter(User.mobile == mobile).first()
    write_audit_log(
        db,
        request,
        action=action,
        entity_type="user",
        entity_id=entity_id or (user.id if user else None),
        new_value={"mobile": mobile, **(details or {})},
    )


def audit_auth_event(
    db: Session,
    request: Request,
    action: str,
    *,
    user_id: str | None = None,
    details: dict | None = None,
) -> None:
    """Writes refresh/logout/auth-session audit events."""
    write_audit_log(
        db,
        request,
        action=action,
        entity_type="user",
        entity_id=user_id,
        new_value=details or None,
    )


@app.post("/auth/request-otp")
def request_otp(payload: OTPRequest, request: Request, db: Session = Depends(get_db)):
    """
    Request an OTP for login.
    Validates mobile exists and is active, enforces 60s cooldown, generates 6-digit OTP,
    hashes it with bcrypt, stores in otp_sessions, and sends SMS using the configured provider.
    """
    purpose = (payload.purpose or "login").strip().lower()
    if purpose not in OTP_PURPOSES:
        raise HTTPException(status_code=400, detail="Unsupported OTP purpose")

    # Validate mobile exists and is active
    user = db.query(User).filter(User.mobile == payload.mobile, User.is_active == True).first()
    if not user:
        raise HTTPException(status_code=400, detail="Invalid mobile number or account inactive")

    # Enforce cooldown: check for unused, unexpired OTP created in last 60 seconds
    cooldown_cutoff = datetime.now(UTC) - timedelta(seconds=OTP_COOLDOWN_SECONDS)
    recent_otp = db.query(OTPSession).filter(
        OTPSession.mobile == payload.mobile,
        OTPSession.purpose == purpose,
        OTPSession.is_used == False,
        OTPSession.expires_at > datetime.now(UTC),
        OTPSession.created_at >= cooldown_cutoff
    ).first()
    if recent_otp:
        audit_otp_event(
            db,
            request,
            action="otp_request_rate_limited",
            mobile=payload.mobile,
            entity_id=user.id,
            details={"cooldown_seconds": OTP_COOLDOWN_SECONDS, "purpose": purpose},
        )
        db.commit()
        raise HTTPException(status_code=429, detail="Please wait 60 seconds before requesting a new OTP")

    # Generate 6-digit OTP and hash it
    otp = generate_otp()
    otp_hash = hash_otp(otp)

    # Insert into otp_sessions
    expires_at = datetime.now(UTC) + timedelta(minutes=OTP_EXPIRE_MINUTES)
    otp_session = OTPSession(
        mobile=payload.mobile,
        otp_code=otp_hash,
        purpose=purpose,
        expires_at=expires_at,
        user_agent=request.headers.get("user-agent")
    )
    db.add(otp_session)
    db.commit()

    delivery_ok = send_template_sms(
        mobile=payload.mobile,
        event_name="otp_login",
        variables={"otp": otp},
        db=db,
    )
    if not delivery_ok and SMS_ENABLED:
        otp_session.is_used = True
        audit_otp_event(
            db,
            request,
            action="otp_delivery_failed",
            mobile=payload.mobile,
            entity_id=user.id,
            details={"purpose": purpose, "provider": "sms_service", "reason": "template_or_delivery_failed"},
        )
        db.commit()
        raise HTTPException(
            status_code=503,
            detail="We could not send the OTP right now. Please try again in a moment.",
        )

    write_audit_log(
        db,
        request,
        action="otp_requested",
        entity_type="user",
        entity_id=user.id,
        new_value={
            "mobile": payload.mobile,
            "purpose": purpose,
            "expires_at": expires_at.isoformat(),
            "delivery_status": "sent" if delivery_ok else "skipped",
            "sms_enabled": SMS_ENABLED,
        }
    )
    db.commit()

    response_payload = {"message": "OTP sent successfully", "expires_in": OTP_EXPIRE_MINUTES * 60}
    return response_payload


@app.post("/auth/verify-otp")
def verify_otp(payload: OTPVerify, request: Request, response: Response, db: Session = Depends(get_db)):
    """
    Verify OTP and issue JWT tokens.
    Looks up latest unused, unexpired OTP, increments attempts, blocks if >= 5 attempts.
    On success: marks OTP used, generates JWT access token and opaque refresh token,
    sets HttpOnly cookies, stores refresh token hash in DB.
    """
    purpose = (payload.purpose or "login").strip().lower()
    if purpose not in OTP_PURPOSES:
        raise HTTPException(status_code=400, detail="Unsupported OTP purpose")

    # Look up latest unused, unexpired OTP session
    otp_session = db.query(OTPSession).filter(
        OTPSession.mobile == payload.mobile,
        OTPSession.purpose == purpose,
        OTPSession.is_used == False,
        OTPSession.expires_at > datetime.now(UTC)
    ).order_by(OTPSession.created_at.desc()).first()

    if not otp_session:
        audit_otp_event(
            db,
            request,
            action="otp_verification_failed",
            mobile=payload.mobile,
            details={"reason": "expired_or_invalid_session", "purpose": purpose},
        )
        db.commit()
        raise HTTPException(status_code=400, detail="OTP expired or invalid")

    # Increment attempts
    otp_session.attempts += 1
    db.commit()

    # Block if attempts >= 5
    if otp_session.attempts >= MAX_OTP_ATTEMPTS:
        otp_session.is_used = True
        audit_otp_event(
            db,
            request,
            action="otp_locked_out",
            mobile=payload.mobile,
            details={"attempts": otp_session.attempts, "reason": "max_attempts_reached", "purpose": purpose},
        )
        db.commit()
        raise HTTPException(status_code=429, detail="Too many failed attempts. Please request a new OTP.")

    # Verify OTP against stored hash
    if not verify_otp_hash(payload.otp, otp_session.otp_code):
        audit_otp_event(
            db,
            request,
            action="otp_verification_failed",
            mobile=payload.mobile,
            details={
                "reason": "invalid_otp",
                "attempts": otp_session.attempts,
                "remaining_attempts": MAX_OTP_ATTEMPTS - otp_session.attempts,
                "purpose": purpose,
            },
        )
        db.commit()
        raise HTTPException(status_code=401, detail="Invalid OTP")

    # Success: mark OTP as used
    otp_session.is_used = True

    # Get user
    user = db.query(User).filter(User.mobile == payload.mobile, User.is_active == True).first()
    if not user:
        raise HTTPException(status_code=400, detail="User not found or inactive")

    # Update last_login
    user.last_login = datetime.now(UTC)

    # Generate JWT access token
    access_token = create_access_token(user.id)

    # Generate opaque refresh token and hash it
    refresh_token = generate_refresh_token()
    refresh_token_hash = hash_token(refresh_token)

    # Store refresh token in DB
    refresh_expires = datetime.now(UTC) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    db_refresh_token = RefreshToken(
        user_id=user.id,
        token_hash=refresh_token_hash,
        token_prefix=refresh_token[:8],
        expires_at=refresh_expires
    )
    db.add(db_refresh_token)

    # Generate CSRF token for double-submit cookie pattern
    csrf_token = generate_csrf_token()

    # Set cookies
    cookie_opts = auth_cookie_options()
    response.set_cookie(
        "access_token",
        access_token,
        max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        **cookie_opts
    )
    response.set_cookie(
        "refresh_token",
        refresh_token,
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60,
        **cookie_opts
    )
    # CSRF cookie is NOT HttpOnly so frontend can read it
    response.set_cookie(
        "csrf_token",
        csrf_token,
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60,
        **csrf_cookie_options(),
    )

    # Audit log
    write_audit_log(
        db,
        request,
        action="otp_verified",
        entity_type="user",
        entity_id=user.id,
        new_value={"mobile": payload.mobile, "purpose": purpose, "login_success": True}
    )
    db.commit()

    return {"message": "Login successful"}


@app.post("/auth/refresh")
def refresh_token(
    request: Request,
    response: Response,
    refresh_token: str = Cookie(None),
    db: Session = Depends(get_db),
):
    """
    Refresh access token using refresh token cookie.
    Validates refresh token, issues new access token, optionally rotates refresh token.
    """
    if not refresh_token:
        audit_auth_event(
            db,
            request,
            action="refresh_failed",
            details={"reason": "missing_refresh_cookie"},
        )
        db.commit()
        raise HTTPException(status_code=401, detail="No refresh token provided")

    # Find refresh token in DB using prefix for efficient lookup
    # This avoids bcrypt-checking all tokens
    candidate_token = db.query(RefreshToken).filter(
        RefreshToken.token_prefix == refresh_token[:8],
        RefreshToken.revoked == False,
        RefreshToken.expires_at > datetime.now(UTC)
    ).first()

    # Verify the hash of the single candidate token
    if not candidate_token or not verify_token_hash(refresh_token, candidate_token.token_hash):
        audit_auth_event(
            db,
            request,
            action="refresh_failed",
            user_id=candidate_token.user_id if candidate_token else None,
            details={"reason": "invalid_or_expired_refresh_token"},
        )
        db.commit()
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    matching_token = candidate_token

    # Get user
    user = db.query(User).filter(User.id == matching_token.user_id, User.is_active == True).first()
    if not user:
        audit_auth_event(
            db,
            request,
            action="refresh_failed",
            user_id=matching_token.user_id,
            details={"reason": "user_not_found_or_inactive"},
        )
        db.commit()
        raise HTTPException(status_code=401, detail="User not found or inactive")

    # Issue new access token
    new_access_token = create_access_token(user.id)

    # Rotate refresh token (recommended security practice)
    # Mark old token as revoked
    matching_token.revoked = True

    # Generate new refresh token
    new_refresh_token = generate_refresh_token()
    new_refresh_hash = hash_token(new_refresh_token)
    new_expires = datetime.now(UTC) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)

    db_new_token = RefreshToken(
        user_id=user.id,
        token_hash=new_refresh_hash,
        token_prefix=new_refresh_token[:8],
        expires_at=new_expires
    )
    db.add(db_new_token)

    # Set cookies
    cookie_opts = auth_cookie_options()
    response.set_cookie(
        "access_token",
        new_access_token,
        max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        **cookie_opts
    )
    response.set_cookie(
        "refresh_token",
        new_refresh_token,
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60,
        **cookie_opts
    )

    # Rotate CSRF token as well for security
    new_csrf_token = generate_csrf_token()
    response.set_cookie(
        "csrf_token",
        new_csrf_token,
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60,
        **csrf_cookie_options(),
    )

    # Audit log
    write_audit_log(
        db,
        request,
        action="token_refreshed",
        entity_type="user",
        entity_id=user.id
    )
    db.commit()

    return {"message": "Token refreshed", "csrf_token": new_csrf_token}


@app.post("/auth/logout")
def logout(
    request: Request,
    response: Response,
    refresh_token: str = Cookie(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Logout: revoke refresh token and clear cookies.
    """
    if refresh_token:
        # Find and revoke the token using prefix for efficient lookup
        candidate_token = db.query(RefreshToken).filter(
            RefreshToken.token_prefix == refresh_token[:8],
            RefreshToken.revoked == False,
            RefreshToken.expires_at > datetime.now(UTC)
        ).first()

        if candidate_token and verify_token_hash(refresh_token, candidate_token.token_hash):
            candidate_token.revoked = True
            db.commit()

    # Audit log
    write_audit_log(
        db,
        request,
        action="logout",
        entity_type="user",
        entity_id=current_user.id,
        current_user=current_user,
    )
    db.commit()

    # Clear cookies
    cookie_opts = auth_cookie_options()
    response.set_cookie("access_token", "", max_age=0, **cookie_opts)
    response.set_cookie("refresh_token", "", max_age=0, **cookie_opts)
    response.set_cookie(
        "csrf_token", "", max_age=0, **csrf_cookie_options(),
    )

    return {"message": "Logged out successfully"}


@app.get("/me")
def get_me(request: Request, access_token: str = Cookie(None), db: Session = Depends(get_db)):
    """
    Get current user info with roles and permissions.
    Requires valid access_token cookie.
    """
    if not access_token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # Decode and validate JWT
    payload = decode_access_token(access_token)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    user_id = payload.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    # Get user with roles and permissions
    user = db.query(User).options(
        joinedload(User.roles).joinedload(Role.permissions)
    ).filter(User.id == user_id, User.is_active == True).first()

    if not user:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    
    # Extract roles
    roles = [role.name for role in user.roles]

    # Extract permissions (flatten and deduplicate)
    permissions = set()
    for role in user.roles:
        for perm in role.permissions:
            permissions.add(perm.action)

    return MeResponse(
        id=user.id,
        name=user.name,
        mobile=user.mobile,
        center_id=user.center_id,
        roles=roles,
        permissions=list(permissions)
    )
