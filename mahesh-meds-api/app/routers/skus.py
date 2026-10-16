"""Device models (SKUs)."""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User, SKU
from app.schemas import SKUCreate, SKUOut, SKUUpdate
from app.security import validate_csrf
from app.permissions import require_permission
from app.audit import write_audit_log

router = APIRouter()


# --- SKU APIs ---
@router.get("/api/v1/skus", response_model=list[SKUOut])
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


@router.delete("/api/v1/skus/{sku_id}")
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


@router.post("/api/v1/skus", response_model=SKUOut)
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


@router.patch("/api/v1/skus/{sku_id}", response_model=SKUOut)
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
