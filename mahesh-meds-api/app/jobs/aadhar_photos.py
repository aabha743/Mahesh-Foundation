"""Deletes Aadhaar card photos some days after a request is finished. The Aadhaar numbers are kept.

AADHAR_PHOTO_RETENTION_DAYS sets the number of days. While it is unset, nothing is deleted.
A request counts as finished when it is rejected, all its devices are back, or its pickup window expired;
the days are counted from its last update (updated_at), which for these requests is when they finished.
"""

import logging
import os
from datetime import datetime, timedelta, UTC

from app.database import SessionLocal
from app.models import AuditLog, LeaseRequest
from app.photo_storage import PhotoStorageError, delete_photo

logger = logging.getLogger(__name__)

FINISHED_STATUSES = ("rejected", "returned", "expired")


def retention_days() -> int | None:
    value = os.getenv("AADHAR_PHOTO_RETENTION_DAYS", "").strip()
    if not value:
        return None
    days = int(value)
    if days < 1:
        raise ValueError("AADHAR_PHOTO_RETENTION_DAYS must be at least 1")
    return days


def delete_expired_aadhar_photos() -> int:
    """Delete the photos of requests finished more than the retention period ago; returns how many requests."""
    try:
        days = retention_days()
    except ValueError:
        logger.exception("Aadhaar photo retention is misconfigured; no photos deleted")
        return 0
    if days is None:
        return 0
    db = SessionLocal()
    cleared = 0
    try:
        cutoff = datetime.now(UTC).replace(tzinfo=None) - timedelta(days=days)
        leases = (
            db.query(LeaseRequest)
            .filter(
                LeaseRequest.status.in_(FINISHED_STATUSES),
                LeaseRequest.aadhar_photo.is_not(None),
                LeaseRequest.aadhar_photos_deleted_at.is_(None),
                LeaseRequest.updated_at < cutoff,
            )
            .all()
        )
        for lease in leases:
            try:
                for name in {lease.aadhar_photo, lease.patient_aadhar_photo} - {None}:
                    delete_photo(name)
                lease.aadhar_photo = None
                lease.patient_aadhar_photo = None
                lease.aadhar_photos_deleted_at = datetime.now(UTC).replace(tzinfo=None)
                db.add(
                    AuditLog(
                        center_id=lease.preferred_center_id,
                        action="aadhar_photos_deleted",
                        entity_type="lease_request",
                        entity_id=lease.id,
                        new_value={
                            "token": lease.token_number,
                            "retention_days": days,
                            "actor_role": "system: Aadhaar photo retention job",
                        },
                    )
                )
                db.commit()
                cleared += 1
            except PhotoStorageError:
                db.rollback()
                logger.exception("Could not delete the Aadhaar photos of request %s", lease.token_number)
        if cleared:
            logger.info("Deleted the Aadhaar photos of %d finished request(s) (retention %d days)", cleared, days)
        return cleared
    finally:
        db.close()
