"""Tracking a request: the public enter a token or mobile number, receive an OTP on the request's mobile and,
once it is verified, get a 30-minute session (cookie) that shows that number's requests and allows an
extension request. Staff screens use their login instead."""

import re

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.audit import write_audit_log
from app.database import get_db
from app.leasing import normalize_public_tracking_mobile
from app.models import AuditLog, LeaseRequest, OTPSession
from app.otp import OtpCheckFailed, check_otp, in_cooldown, send_otp
from app.schemas import TrackOtpRequest, TrackOtpVerify
from app.security import (
    COOKIE_DOMAIN,
    OTP_COOLDOWN_SECONDS,
    OTP_EXPIRE_MINUTES,
    TRACK_COOKIE,
    TRACK_SESSION_MINUTES,
    create_track_token,
    track_cookie_options,
)

router = APIRouter()

OTP_PURPOSE = "track"
MAX_OTPS_PER_NUMBER_PER_DAY = 5
MAX_OTP_REQUESTS_PER_DEVICE_PER_HOUR = 20  # counted by IP address (nginx passes the real client address)


def resolve_query(db: Session, query: str) -> tuple[str, str]:
    """('mobile', number) for a phone number, or ('token', the request's mobile) for a token."""
    query = query.strip()
    if re.fullmatch(r"[+\d\s()-]+", query):
        mobile = normalize_public_tracking_mobile(query)
        if not mobile:
            raise HTTPException(status_code=400, detail="Enter a valid 10-digit mobile number or a token")
        return "mobile", mobile
    lease = db.query(LeaseRequest).filter(func.lower(LeaseRequest.token_number) == query.lower()).first()
    if not lease:
        raise HTTPException(status_code=404, detail="No request found with that token")
    return "token", lease.mobile


def audit(db: Session, request: Request, action: str, kind: str, mobile: str, **details) -> None:
    write_audit_log(db, request, action=action, entity_type="token", new_value={"mobile": mobile, "lookup": kind, **details})


@router.post("/api/v1/track/send-otp")
def send_tracking_otp(payload: TrackOtpRequest, request: Request, db: Session = Depends(get_db)):
    """Text an OTP to the mobile on the request (token) or to the number entered, if it has any request.
    The reply is the same whether or not a number has requests, so it cannot be used to find out."""
    kind, mobile = resolve_query(db, payload.query)
    ip = request.client.host if request.client else None
    if ip:
        recent = db.query(AuditLog.id).filter(
            AuditLog.action == "track_otp_requested",
            AuditLog.ip_address == ip,
            AuditLog.created_at >= func.date_sub(func.now(), text("INTERVAL 1 HOUR")),
        ).count()
        if recent >= MAX_OTP_REQUESTS_PER_DEVICE_PER_HOUR:
            audit(db, request, "track_otp_rate_limited", kind, mobile, limit="device_per_hour")
            db.commit()
            raise HTTPException(status_code=429, detail="Too many OTP requests from this device. Please try again in an hour.")

    has_requests = kind == "token" or db.query(LeaseRequest.id).filter(LeaseRequest.mobile == mobile).first() is not None
    audit(db, request, "track_otp_requested", kind, mobile, has_requests=has_requests)
    db.commit()
    if has_requests:
        if in_cooldown(db, mobile, OTP_PURPOSE):
            raise HTTPException(status_code=429, detail=f"Please wait {OTP_COOLDOWN_SECONDS} seconds before requesting a new OTP")
        sent_today = db.query(OTPSession.id).filter(
            OTPSession.mobile == mobile,
            OTPSession.purpose == OTP_PURPOSE,
            OTPSession.created_at >= func.date_sub(func.now(), text("INTERVAL 1 DAY")),
        ).count()
        if sent_today >= MAX_OTPS_PER_NUMBER_PER_DAY:
            audit(db, request, "track_otp_rate_limited", kind, mobile, limit="number_per_day")
            db.commit()
            raise HTTPException(status_code=429, detail="Too many OTPs for this number today. Please try again tomorrow.")
        if not send_otp(db, request, mobile, OTP_PURPOSE):
            raise HTTPException(status_code=503, detail="We could not send the OTP right now. Please try again in a moment.")
    return {
        "sent_to": f"ending {mobile[-2:]}",
        "expires_in": OTP_EXPIRE_MINUTES * 60,
        "resend_in": OTP_COOLDOWN_SECONDS,
    }


@router.post("/api/v1/track/verify-otp")
def verify_tracking_otp(payload: TrackOtpVerify, request: Request, response: Response, db: Session = Depends(get_db)):
    """Check the OTP and start a 30-minute tracking session for that mobile number."""
    kind, mobile = resolve_query(db, payload.query)
    try:
        check_otp(db, mobile, OTP_PURPOSE, payload.otp.strip())
    except OtpCheckFailed as failure:
        audit(db, request, "track_otp_failed", kind, mobile, reason=failure.reason, attempts=failure.attempts)
        db.commit()
        raise HTTPException(status_code=failure.status_code, detail=failure.detail) from None
    audit(db, request, "track_otp_verified", kind, mobile)
    db.commit()
    response.set_cookie(TRACK_COOKIE, create_track_token(mobile), **track_cookie_options())
    return {"verified": True, "expires_in": TRACK_SESSION_MINUTES * 60}


@router.post("/api/v1/track/logout")
def end_tracking_session(response: Response):
    """End the tracking session in this browser."""
    response.delete_cookie(TRACK_COOKIE, path="/", domain=COOKIE_DOMAIN)
    return {"ended": True}
