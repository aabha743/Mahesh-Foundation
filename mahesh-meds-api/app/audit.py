"""The activity log: writing entries and classifying them into report sections."""

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from fastapi import Request
from sqlalchemy.orm import Session

from app.models import User, AuditLog
from app.security import decode_access_token


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
