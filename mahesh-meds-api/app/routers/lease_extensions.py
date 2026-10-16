"""Lease extension requests and their review."""

from datetime import datetime, UTC, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User, LeaseRequest, LeaseExtension
from app.schemas import LeaseExtensionCreate, LeaseExtensionOut, LeaseExtensionReview
from app.security import validate_csrf
from app.permissions import (
    enforce_center_resource_access,
    is_center_scoped_operator,
    require_any_permission,
    require_extension_review_permission,
)
from app.leasing import active_lease_items, evaluate_extension_eligibility, normalize_person_name
from app.audit import write_audit_log

router = APIRouter()


@router.post("/api/v1/lease-extensions", response_model=LeaseExtensionOut)
def create_lease_extension(
    payload: LeaseExtensionCreate,
    request: Request,
    db: Session = Depends(get_db),
):
    """Public lease extension request endpoint validated against the existing lease token."""
    if not payload.reason or not payload.reason.strip():
        raise HTTPException(status_code=400, detail="Reason for extension is required.")

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
    if requested_days > 14:
        raise HTTPException(status_code=400, detail="The maximum time you can request for extension is 2 weeks.")

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


@router.get("/api/v1/lease-extensions", response_model=list[LeaseExtensionOut])
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


@router.patch("/api/v1/lease-extensions/{extension_id}", response_model=LeaseExtensionOut)
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
        # No reason is required; one sent by an older screen is kept for staff only.
        extension.status = "rejected"
        extension.rejection_reason = (payload.rejection_reason or "").strip() or None
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
