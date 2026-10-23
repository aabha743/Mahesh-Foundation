import logging
from datetime import date, datetime, timedelta, UTC
from zoneinfo import ZoneInfo

from sqlalchemy import and_, exists, func
from sqlalchemy.orm import Session, joinedload

from app.database import SessionLocal
from app.models import AuditLog, LeaseItem, LeaseRequest, NotificationLog, SKUBlock
from app.notifications import notify_request_expired
from app.services.sms import format_mobile, send_template_sms

logger = logging.getLogger(__name__)

INDIA_TZ = ZoneInfo("Asia/Kolkata")
ACTIVE_LEASE_STATUSES = {"issued", "partially_returned"}


def _today_ist() -> date:
    return datetime.now(INDIA_TZ).date()


def _format_due_date(value: date | None) -> str:
    if value is None:
        return "N/A"
    return value.strftime("%d %b %Y")


def _active_unreturned_item_clause():
    return exists().where(
        and_(
            LeaseItem.lease_request_id == LeaseRequest.id,
            LeaseItem.issued_at.is_not(None),
            LeaseItem.asset_id.is_not(None),
            LeaseItem.returned_at.is_(None),
        )
    )


def _normalize_mobile_candidates(mobile: str) -> list[str]:
    candidates = [mobile]
    try:
        formatted = format_mobile(mobile)
    except ValueError:
        formatted = None
    if formatted and formatted not in candidates:
        candidates.append(formatted)
    return candidates


def already_sent_today(
    db: Session,
    mobile: str,
    event_name: str,
    reference_id: str,
) -> bool:
    today = _today_ist()
    mobile_candidates = _normalize_mobile_candidates(mobile)
    sent = (
        db.query(NotificationLog.id)
        .filter(NotificationLog.recipient_mobile.in_(mobile_candidates))
        .filter(NotificationLog.type == event_name)
        .filter(NotificationLog.reference_id == reference_id)
        .filter(func.date(NotificationLog.sent_at) == today)
        .filter(NotificationLog.status.in_(["sent", "skipped"]))
        .first()
    )
    return sent is not None


def _due_date_target_leases(db: Session) -> list[LeaseRequest]:
    today = _today_ist()
    target_dates = {
        today + timedelta(days=7),
        today + timedelta(days=3),
        today + timedelta(days=1),
    }
    return (
        db.query(LeaseRequest)
        .options(joinedload(LeaseRequest.preferred_center))
        .filter(LeaseRequest.status.in_(ACTIVE_LEASE_STATUSES))
        .filter(LeaseRequest.due_date.is_not(None))
        .filter(LeaseRequest.due_date.in_(target_dates))
        .filter(_active_unreturned_item_clause())
        .all()
    )


def send_due_date_reminders() -> None:
    db = SessionLocal()
    try:
        today = _today_ist()
        event_map = {
            7: "return_reminder_7d",
            3: "return_reminder_3d",
            1: "return_reminder_1d",
        }
        for lease in _due_date_target_leases(db):
            if lease.due_date is None:
                continue
            days_until_due = (lease.due_date - today).days
            event_name = event_map.get(days_until_due)
            if not event_name:
                continue
            if already_sent_today(db, lease.mobile, event_name, lease.id):
                continue
            send_template_sms(
                mobile=lease.mobile,
                event_name=event_name,
                variables={
                    "token_number": lease.token_number,
                    "due_date": _format_due_date(lease.due_date),
                },
                db=db,
                reference_id=lease.id,
            )
    except Exception:
        logger.exception("Scheduled due date reminder job failed")
    finally:
        db.close()


def _overdue_holds(db: Session, now_time: datetime, lease_request_id: str | None = None):
    query = (
        db.query(SKUBlock)
        .filter(SKUBlock.status == "blocked")
        .filter(SKUBlock.release_at.is_not(None))
        .filter(SKUBlock.release_at < now_time)
    )
    if lease_request_id is not None:
        query = query.filter(SKUBlock.lease_request_id == lease_request_id)
    return query


def _release_request_holds(db: Session, lease_request_id: str, now_time: datetime) -> LeaseRequest | None:
    """Release one request's overdue holds; expire the request if nothing was ever issued on it.
    Returns the request when it was expired."""
    req = db.get(LeaseRequest, lease_request_id)
    has_issued_lines = (
        db.query(LeaseItem.id)
        .filter(LeaseItem.lease_request_id == lease_request_id, LeaseItem.asset_id.is_not(None))
        .first()
        is not None
    )
    reason = "approved_timeout" if req and req.status == "approved" else "timeout"
    for block in _overdue_holds(db, now_time, lease_request_id).all():
        block.status = "released"
        block.release_reason = reason
        block.release_at = now_time

    # A partly issued request keeps its status: a device is already with the patient.
    if req and req.status == "approved" and not has_issued_lines:
        req.status = "expired"
        db.add(
            AuditLog(
                center_id=req.preferred_center_id,
                action="request_expired",
                entity_type="lease_request",
                entity_id=req.id,
                old_value={"status": "approved", "token": req.token_number},
                new_value={"status": "expired", "token": req.token_number, "actor_role": "system: pickup window job"},
            )
        )
        logger.info("Request %s expired: pickup window passed without collection", req.token_number)
        return req
    logger.info("Released overdue stock holds for request %s (%s)", lease_request_id, reason)
    return None


def release_expired_blocks() -> None:
    """Releases stock holds whose pickup window has passed and expires uncollected approved requests.

    Each request is committed on its own, so one bad row cannot block the rest.
    """
    db = SessionLocal()
    try:
        now_time = datetime.now(UTC).replace(tzinfo=None)
        lease_request_ids = [
            row.lease_request_id
            for row in _overdue_holds(db, now_time).with_entities(SKUBlock.lease_request_id).distinct()
        ]
        for lease_request_id in lease_request_ids:
            try:
                expired = _release_request_holds(db, lease_request_id, now_time)
                db.commit()
            except Exception:
                db.rollback()
                logger.exception("Could not release overdue stock holds for request %s", lease_request_id)
                continue
            if expired:
                try:
                    notify_request_expired(db, expired)
                except Exception:
                    logger.exception("Could not send the expiry SMS for request %s", expired.token_number)
    finally:
        db.close()
