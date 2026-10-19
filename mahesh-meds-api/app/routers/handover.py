"""Device handover: before devices are issued, the center texts an OTP to the request's mobile and enters the
code the person collecting them reads out. An accepted code lets that staff member issue devices for the
request once, within HANDOVER_VERIFICATION_MINUTES; the issue itself is refused without it
(leasing.use_handover_verification, called by PATCH /api/v1/lease-requests/{id})."""

from datetime import datetime, UTC, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.audit import write_audit_log
from app.database import get_db
from app.leasing import EXPIRED_REQUEST_DETAIL, HANDOVER_VERIFICATION_MINUTES, has_devices_to_issue
from app.models import Center, LeaseHandoverVerification, LeaseRequest, OTPSession, User
from app.otp import OtpCheckFailed, check_otp, in_cooldown, send_otp
from app.permissions import enforce_center_resource_access, require_permission
from app.schemas import HandoverOtpRequest, HandoverOtpVerify
from app.security import MAX_OTP_ATTEMPTS, OTP_COOLDOWN_SECONDS, OTP_EXPIRE_MINUTES, validate_csrf

router = APIRouter()

MAX_HANDOVER_OTPS_PER_REQUEST_PER_DAY = 5


def otp_purpose(lease: LeaseRequest) -> str:
    """Codes are tied to one request, so a code sent for one of a number's requests cannot release another."""
    return f"issue:{lease.id}"


def load_issuable_lease(db: Session, lease_id: str, center_id: str, current_user: User) -> LeaseRequest:
    lease = db.get(LeaseRequest, lease_id)
    if not lease:
        raise HTTPException(status_code=404, detail="Lease request not found")
    if not db.get(Center, center_id):
        raise HTTPException(status_code=400, detail="Invalid center_id")
    enforce_center_resource_access(current_user, db, center_id)
    if lease.status == "expired":
        raise HTTPException(status_code=400, detail=EXPIRED_REQUEST_DETAIL)
    if not has_devices_to_issue(db, lease):
        raise HTTPException(status_code=400, detail="This request has no devices waiting to be issued")
    return lease


def audit(db: Session, request: Request, action: str, lease: LeaseRequest, center_id: str, user: User, **details) -> None:
    write_audit_log(
        db,
        request,
        action=action,
        entity_type="lease_request",
        entity_id=lease.id,
        center_id=center_id,
        new_value={"token": lease.token_number, "sent_to": f"ending {lease.mobile[-2:]}", **details},
        current_user=user,
    )


@router.post("/api/v1/lease-requests/{lease_id}/handover/send-otp")
def send_handover_otp(
    lease_id: str,
    payload: HandoverOtpRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("devices.issue")),
    _: None = Depends(validate_csrf),
):
    """Text an OTP to the mobile number on the request, for the person collecting the devices to read out."""
    lease = load_issuable_lease(db, lease_id, payload.center_id, current_user)
    purpose = otp_purpose(lease)
    if in_cooldown(db, lease.mobile, purpose):
        raise HTTPException(status_code=429, detail=f"Please wait {OTP_COOLDOWN_SECONDS} seconds before sending a new OTP")
    sent_today = db.query(OTPSession.id).filter(
        OTPSession.mobile == lease.mobile,
        OTPSession.purpose == purpose,
        OTPSession.created_at >= func.date_sub(func.now(), text("INTERVAL 1 DAY")),
    ).count()
    if sent_today >= MAX_HANDOVER_OTPS_PER_REQUEST_PER_DAY:
        audit(db, request, "handover_otp_rate_limited", lease, payload.center_id, current_user)
        db.commit()
        raise HTTPException(status_code=429, detail="Too many OTPs for this request today. Please try again tomorrow.")
    if not send_otp(db, request, lease.mobile, purpose):
        raise HTTPException(status_code=503, detail="We could not send the OTP right now. Please try again in a moment.")
    audit(db, request, "handover_otp_sent", lease, payload.center_id, current_user)
    db.commit()
    return {
        "sent_to": f"ending {lease.mobile[-2:]}",
        "expires_in": OTP_EXPIRE_MINUTES * 60,
        "resend_in": OTP_COOLDOWN_SECONDS,
    }


@router.post("/api/v1/lease-requests/{lease_id}/handover/verify-otp")
def verify_handover_otp(
    lease_id: str,
    payload: HandoverOtpVerify,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("devices.issue")),
    _: None = Depends(validate_csrf),
):
    """Check the code the person read out; if it is right, this staff member may issue devices for the request once."""
    lease = load_issuable_lease(db, lease_id, payload.center_id, current_user)
    try:
        check_otp(db, lease.mobile, otp_purpose(lease), payload.otp.strip())
    except OtpCheckFailed as failure:
        audit(db, request, "handover_otp_failed", lease, payload.center_id, current_user,
              reason=failure.reason, attempts=failure.attempts)
        db.commit()
        if failure.status_code == 401:
            # 401 would read as "staff session expired" on the staff screens; this is just a wrong code.
            tries_left = MAX_OTP_ATTEMPTS - (failure.attempts or 0)
            raise HTTPException(
                status_code=400,
                detail=f"Incorrect OTP. {tries_left} {'try' if tries_left == 1 else 'tries'} left.",
            ) from None
        raise HTTPException(status_code=failure.status_code, detail=failure.detail) from None

    now = datetime.now(UTC).replace(tzinfo=None)
    verification = LeaseHandoverVerification(
        lease_request_id=lease.id,
        center_id=payload.center_id,
        verified_by=current_user.id,
        verified_at=now,
        expires_at=now + timedelta(minutes=HANDOVER_VERIFICATION_MINUTES),
    )
    db.add(verification)
    db.flush()
    audit(db, request, "handover_otp_verified", lease, payload.center_id, current_user, verification_id=verification.id)
    db.commit()
    return {"verified": True, "expires_in": HANDOVER_VERIFICATION_MINUTES * 60}
