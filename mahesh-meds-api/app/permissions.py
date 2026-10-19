"""Who may do what: current user, role permissions (cached), center scoping and lease-update permissions."""

import time
from collections.abc import Callable

from fastapi import Cookie, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.models import User, Role, LeaseRequest, LeaseItem
from app.schemas import LeaseRequestUpdate, LeaseExtensionReview
from app.security import decode_access_token


ALLOWED_USER_ROLES = {"master_admin", "approver", "center_manager", "asset_manager"}

# =============================================================================
# RBAC DEPENDENCIES
# =============================================================================


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


def get_optional_user(
    db: Session = Depends(get_db),
    access_token: str = Cookie(None)
) -> User | None:
    """For public endpoints that show staff a little more: the logged-in staff user, or None for visitors."""
    try:
        return get_current_user(db, access_token)
    except HTTPException:
        return None


OTP_REQUIRED_DETAIL = "Verify with the OTP sent to the request's mobile number to see this request."


def ensure_can_view_request(request_mobile: str, viewer: User | None, track_mobile: str | None) -> None:
    """Requests are shown to staff, or to a browser that verified the request's mobile number by OTP."""
    if viewer is None and track_mobile != request_mobile:
        raise HTTPException(status_code=401, detail=OTP_REQUIRED_DETAIL)


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


def required_lease_permission(
    payload: LeaseRequestUpdate,
    lease: LeaseRequest,
    existing_items: list[LeaseItem],
) -> str:
    """Decide which permission a lease update needs from what it changes compared with the stored request:
    - assigning a device not yet on the request (full or partial issue) -> devices.issue
    - removing an assigned device, or closing -> devices.collect
    - approving a pending or expired request -> requests.approve
    - rejecting -> requests.reject
    - anything else, e.g. an approver changing items or notes -> requests.edit
    """
    if payload.status == "rejected":
        return "requests.reject"
    if payload.status == "closed":
        return "devices.collect"
    if payload.items is not None:
        assigned_before = {item.asset_id for item in existing_items if item.asset_id}
        assigned_after = {item.asset_id for item in payload.items if item.asset_id}
        if assigned_after - assigned_before:
            return "devices.issue"
        if assigned_before - assigned_after:
            return "devices.collect"
    if payload.status == "approved" and lease.status in {"pending", "expired"}:
        return "requests.approve"
    return "requests.edit"


def require_lease_permission(
    lease_id: str,
    payload: LeaseRequestUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
) -> User:
    """Dependency for lease request PATCH; see required_lease_permission for the mapping."""
    lease = db.get(LeaseRequest, lease_id)
    if not lease:
        raise HTTPException(status_code=404, detail="Lease request not found")
    existing_items = db.query(LeaseItem).filter(LeaseItem.lease_request_id == lease.id).all()
    required_permission = required_lease_permission(payload, lease, existing_items)

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
