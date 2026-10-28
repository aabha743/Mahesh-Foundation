"""Records whether each SMS BulkSMS accepted actually reached the phone.

send_sms keeps the MessageId of every accepted message and marks it pending. This job asks BulkSMS about pending
messages: delivered and failed are final, and a message still without a final report GIVE_UP_AFTER after it was sent
is marked no_report (a message DLT blocks stays AWAITED-DLR for good, so in practice it was not delivered). Recent
messages are asked about on every run, older ones less often, and at most MAX_CHECKS_PER_RUN per run. Failures are
logged as warnings with the log row id, never the phone number. Nothing happens while SMS is off.
"""

import logging
import os
from datetime import datetime, timedelta

from sqlalchemy import func

from app.database import SessionLocal
from app.models import NotificationLog
from app.services import sms

logger = logging.getLogger(__name__)

FIRST_CHECK_AFTER = timedelta(minutes=2)
GIVE_UP_AFTER = timedelta(hours=48)
MAX_CHECKS_PER_RUN = 50


def _recheck_after(age: timedelta) -> timedelta:
    """How long to wait between two questions about one message: often while a report is likely, then less."""
    if age < timedelta(hours=1):
        return timedelta(minutes=5)  # every run
    if age < timedelta(hours=6):
        return timedelta(hours=1)
    return timedelta(hours=6)


def _is_due(row: NotificationLog, now: datetime) -> bool:
    if row.delivery_checked_at is None:
        return True
    return now - row.delivery_checked_at >= _recheck_after(now - row.sent_at)


def _record(row: NotificationLog, outcome: str, code: str, now: datetime) -> None:
    row.delivery_checked_at = now
    row.delivery_detail = code[:255]
    if outcome in ("delivered", "failed"):
        row.delivery_status = outcome
    elif now - row.sent_at >= GIVE_UP_AFTER:
        row.delivery_status = "no_report"
    if outcome == "unrecognised":
        logger.warning("Unrecognised BulkSMS delivery report for SMS %s (%s): %s", row.id, row.type, code)
    if row.delivery_status in ("failed", "no_report"):
        logger.warning("SMS %s (%s) was not delivered: %s, BulkSMS reported %s", row.id, row.type, row.delivery_status, code)


def check_sms_delivery() -> int:
    """Ask BulkSMS about the pending messages that are due; returns how many it answered for."""
    if os.getenv("SMS_ENABLED", "true").lower() != "true" or not sms.SMS_API_KEY:
        return 0
    db = SessionLocal()
    checked = 0
    try:
        now = db.query(func.now()).scalar()  # sent_at comes from the database clock
        pending = (
            db.query(NotificationLog)
            .filter(
                NotificationLog.delivery_status == "pending",
                NotificationLog.provider_message_id.is_not(None),
                NotificationLog.sent_at <= now - FIRST_CHECK_AFTER,
            )
            .order_by(NotificationLog.sent_at)
            .all()
        )
        # Never-asked messages first, then the oldest.
        due = sorted((row for row in pending if _is_due(row, now)), key=lambda row: row.delivery_checked_at is not None)
        for row in due[:MAX_CHECKS_PER_RUN]:
            try:
                outcome, code = sms.fetch_delivery_status(row.provider_message_id)
            except sms.DeliveryLookupError as exc:
                # The same answer is likely for every message (BulkSMS down, key refused): try again next run.
                logger.warning("SMS delivery check stopped after %d message(s): %s", checked, exc)
                break
            _record(row, outcome, code, now)
            db.commit()
            checked += 1
        return checked
    except Exception:
        db.rollback()
        logger.exception("Scheduled SMS delivery check failed")
        return checked
    finally:
        db.close()
