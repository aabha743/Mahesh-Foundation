"""Aadhaar card photos of a request, for the staff who review requests (approve or reject). Every view is
recorded in the audit log; photos are never cached by the browser and have no public link."""

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.audit import write_audit_log
from app.database import get_db
from app.models import LeaseRequest, User
from app.permissions import AADHAR_REVIEW_PERMISSIONS as PHOTO_REVIEW_PERMISSIONS
from app.permissions import require_any_permission
from app.photo_storage import PhotoNotFound, PhotoStorageError, load_photo

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/api/v1/lease-requests/{lease_id}/aadhar-photo/{whose}")
def get_aadhar_photo(
    lease_id: str,
    whose: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_any_permission(*PHOTO_REVIEW_PERMISSIONS)),
):
    """The requester's or the patient's Aadhaar card photo."""
    if whose not in ("requester", "patient"):
        raise HTTPException(status_code=404, detail="Unknown photo")
    lease = db.get(LeaseRequest, lease_id)
    if not lease:
        raise HTTPException(status_code=404, detail="Lease request not found")
    if lease.aadhar_photos_deleted_at:
        raise HTTPException(status_code=410, detail="The Aadhaar photos were deleted after the retention period")
    name = lease.aadhar_photo if whose == "requester" else lease.patient_aadhar_photo
    if not name:
        raise HTTPException(status_code=404, detail="This request has no Aadhaar photo")
    try:
        data, content_type = load_photo(name)
    except PhotoNotFound:
        logger.error("Aadhaar photo %s of request %s is missing from storage", name, lease.token_number)
        raise HTTPException(status_code=404, detail="The photo could not be found") from None
    except PhotoStorageError:
        logger.exception("Could not read Aadhaar photo of request %s", lease.token_number)
        raise HTTPException(status_code=503, detail="The photo could not be loaded right now") from None

    write_audit_log(
        db,
        request,
        action="aadhar_photo_viewed",
        entity_type="lease_request",
        entity_id=lease.id,
        new_value={"token": lease.token_number, "whose": whose},
        current_user=current_user,
    )
    db.commit()
    return Response(
        content=data,
        media_type=content_type,
        headers={
            "Cache-Control": "no-store, private",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": "inline",
        },
    )
