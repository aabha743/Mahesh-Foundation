"""Devices (assets) and stock levels."""

from datetime import datetime, UTC

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import (
    Center,
    User,
    SKU,
    Asset,
    LeaseRequest,
    LeaseItem,
)
from app.schemas import AssetCreate, AssetOut, AssetUpdate, AssetOwnershipUpdate
from app.security import validate_csrf
from app.permissions import enforce_center_resource_access, is_center_scoped_operator, require_permission
from app.leasing import (
    RETURNABLE_LEASE_DB_STATUSES,
    asset_status_to_api,
    asset_status_to_db,
    settle_lease_after_return,
)
from app.audit import write_audit_log

router = APIRouter()


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


# --- Asset APIs ---
@router.get("/api/v1/assets", response_model=list[AssetOut])
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


@router.get("/api/v1/stock")
def get_sku_stock(db: Session = Depends(get_db)):
    """Returns calculated available stock per SKU and center (subtracting active SKUBlock reservations)."""
    rows = db.execute(
        text("SELECT sku_id, center_id, available_count FROM sku_stock_by_center")
    ).mappings().all()
    return [dict(row) for row in rows]


@router.post("/api/v1/assets", response_model=AssetOut)
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


@router.patch("/api/v1/assets/{asset_id}", response_model=AssetOut)
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
    returned_line = None
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
            returned_line = lease_item

    for key, value in data.items():
        setattr(asset, key, value)
    if returned_line:
        # Returns normally go through POST /lease-requests/{id}/returns; this keeps the request in step
        # when a leased device is marked available or under repair here instead (Assets page).
        lease = db.get(LeaseRequest, returned_line.lease_request_id)
        if lease and lease.status in RETURNABLE_LEASE_DB_STATUSES:
            lines = db.query(LeaseItem).filter(LeaseItem.lease_request_id == lease.id).all()
            settle_lease_after_return(db, lease, lines)
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


@router.patch("/api/v1/assets/{asset_id}/ownership", response_model=AssetOut)
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


@router.delete("/api/v1/assets/{asset_id}")
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
