"""Centers."""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Center, User
from app.schemas import CenterCreate, CenterOut
from app.security import validate_csrf
from app.permissions import require_permission
from app.audit import write_audit_log

router = APIRouter()


# --- Center APIs ---
@router.get("/api/v1/centers", response_model=list[CenterOut])
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


@router.delete("/api/v1/centers/{center_id}")
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


@router.post("/api/v1/centers", response_model=CenterOut)
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
