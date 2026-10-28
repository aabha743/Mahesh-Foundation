"""Activity log feeds (admin reports and center dashboards)."""

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Center, User, AuditLog
from app.schemas import AuditLogOut
from app.permissions import get_current_user, require_permission
from app.audit import _section_for_log, section_clause

router = APIRouter()


# --- Audit feed APIs ---
@router.get("/api/v1/audit-logs")
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
    # Section and token are filtered by the database, before the row limit, so older entries are not cut off.
    if section:
        query = query.filter(section_clause(section))
    if token:
        query = query.filter(AuditLog.token == token.strip())

    logs = query.order_by(AuditLog.created_at.desc(), AuditLog.id).offset(offset).limit(limit).all()
    user_ids = [log.user_id for log in logs if log.user_id]
    center_ids = [log.center_id for log in logs if log.center_id]
    users = db.query(User).filter(User.id.in_(user_ids)).all() if user_ids else []
    centers = db.query(Center).filter(Center.id.in_(center_ids)).all() if center_ids else []
    user_name_by_id = {u.id: u.name for u in users}
    center_name_by_id = {c.id: c.name for c in centers}
    rows: list[dict] = []
    for log in logs:
        sec = _section_for_log(log.entity_type, log.action)
        rows.append(
            {
                **AuditLogOut.model_validate(log).model_dump(),
                "section": sec,
                "user_name": user_name_by_id.get(log.user_id) if log.user_id else None,
                "center_name": center_name_by_id.get(log.center_id) if log.center_id else None,
            }
        )
    return rows


@router.get("/api/v1/center/activity")
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

    query = db.query(AuditLog).filter(AuditLog.center_id == requested_center_id)
    if section:
        query = query.filter(section_clause(section))
    logs = query.order_by(AuditLog.created_at.desc(), AuditLog.id).limit(limit).all()
    user_ids = [log.user_id for log in logs if log.user_id]
    users = db.query(User).filter(User.id.in_(user_ids)).all() if user_ids else []
    user_name_by_id = {u.id: u.name for u in users}

    rows: list[dict] = []
    for log in logs:
        sec = _section_for_log(log.entity_type, log.action)
        rows.append(
            {
                **AuditLogOut.model_validate(log).model_dump(),
                "section": sec,
                "user_name": user_name_by_id.get(log.user_id) if log.user_id else None,
                "center_name": None,
            }
        )
    return rows
