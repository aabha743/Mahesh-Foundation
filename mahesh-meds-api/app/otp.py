"""One-time passwords sent by SMS, shared by staff login and request tracking.

A code is valid for OTP_EXPIRE_MINUTES, a new one can be requested after OTP_COOLDOWN_SECONDS, and the
MAX_OTP_ATTEMPTS-th wrong try cancels it. Codes are stored hashed and the SMS log shows them masked.
"""
import os
from datetime import datetime, UTC, timedelta

from fastapi import Request
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.models import OTPSession
from app.security import (
    MAX_OTP_ATTEMPTS,
    OTP_COOLDOWN_SECONDS,
    OTP_EXPIRE_MINUTES,
    generate_otp,
    hash_otp,
    verify_otp_hash,
)
from app.services.sms import send_template_sms


class OtpCheckFailed(Exception):
    """The code was not accepted; status_code and detail are what the API returns, reason goes to the audit log."""

    def __init__(self, status_code: int, detail: str, reason: str, attempts: int | None = None):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.reason = reason
        self.attempts = attempts


def in_cooldown(db: Session, mobile: str, purpose: str) -> bool:
    """True if a code for this number and purpose was sent less than OTP_COOLDOWN_SECONDS ago and is still usable."""
    return db.query(OTPSession.id).filter(
        OTPSession.mobile == mobile,
        OTPSession.purpose == purpose,
        OTPSession.is_used == False,  # noqa: E712
        OTPSession.expires_at > datetime.now(UTC),
        # created_at is set by the database, so compare it with the database clock
        OTPSession.created_at >= func.date_sub(func.now(), text(f"INTERVAL {OTP_COOLDOWN_SECONDS} SECOND")),
    ).first() is not None


def send_otp(db: Session, request: Request, mobile: str, purpose: str) -> bool:
    """Create a code, store it hashed and text it to the number. Returns False if SMS is on but sending failed;
    the code is then cancelled so it cannot be used."""
    otp = generate_otp()
    session = OTPSession(
        mobile=mobile,
        otp_code=hash_otp(otp),
        purpose=purpose,
        expires_at=datetime.now(UTC) + timedelta(minutes=OTP_EXPIRE_MINUTES),
        user_agent=request.headers.get("user-agent"),
    )
    db.add(session)
    db.commit()
    delivered = send_template_sms(
        mobile=mobile, event_name="otp_login", variables={"otp": otp}, db=db, secret_variables=("otp",)
    )
    if not delivered and os.getenv("SMS_ENABLED", "true").lower() == "true":
        session.is_used = True
        db.commit()
        return False
    return True


def check_otp(db: Session, mobile: str, purpose: str, code: str) -> OTPSession:
    """Accept the latest usable code for this number and purpose, or raise OtpCheckFailed."""
    session = db.query(OTPSession).filter(
        OTPSession.mobile == mobile,
        OTPSession.purpose == purpose,
        OTPSession.is_used == False,  # noqa: E712
        OTPSession.expires_at > datetime.now(UTC),
    ).order_by(OTPSession.created_at.desc()).first()
    if not session:
        raise OtpCheckFailed(400, "OTP expired or invalid", "expired_or_invalid_session")

    session.attempts += 1
    if verify_otp_hash(code, session.otp_code):
        session.is_used = True
        db.commit()
        return session
    if session.attempts >= MAX_OTP_ATTEMPTS:
        session.is_used = True
        db.commit()
        raise OtpCheckFailed(429, "Too many failed attempts. Please request a new OTP.", "max_attempts_reached", session.attempts)
    db.commit()
    raise OtpCheckFailed(401, "Invalid OTP", "invalid_otp", session.attempts)
