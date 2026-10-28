"""Staff login: OTP request/verify, session refresh, logout and /me."""

import os
from datetime import datetime, UTC, timedelta

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from sqlalchemy import func, text
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.models import AuditLog, OTPSession, User, Role, RefreshToken
from app.schemas import OTPRequest, OTPVerify, MeResponse
from app.security import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    MAX_OTP_ATTEMPTS,
    OTP_COOLDOWN_SECONDS,
    OTP_EXPIRE_MINUTES,
    OTP_PURPOSES,
    REFRESH_TOKEN_EXPIRE_DAYS,
    auth_cookie_options,
    create_access_token,
    csrf_cookie_options,
    decode_access_token,
    generate_csrf_token,
    generate_refresh_token,
    hash_token,
    verify_token_hash,
)
from app.permissions import get_current_user
from app.audit import write_audit_log
from app.otp import WRONG_CODES_DETAIL, OtpCheckFailed, check_otp, in_cooldown, send_otp, too_many_wrong_codes

router = APIRouter()

# Staff login codes. Unknown numbers are counted against the same limits (from the audit log) and get the same
# replies, so the login screen cannot be used to find out which numbers belong to staff.
MAX_LOGIN_OTPS_PER_NUMBER_PER_HOUR = 5
MAX_LOGIN_OTPS_PER_NUMBER_PER_DAY = 10
MAX_LOGIN_OTP_REQUESTS_PER_DEVICE_PER_HOUR = 20  # counted by IP address
# After this many codes are cancelled for wrong tries within a day, no new login codes for LOGIN_LOCK_HOURS.
LOGIN_LOCK_AFTER_CANCELLED_CODES = 3
LOGIN_LOCK_HOURS = 24
OTP_SENT_MESSAGE = "If this number is registered, an OTP has been sent to it."
LOGIN_LOCKED_DETAIL = (
    "Too many wrong codes for this number. New codes are blocked for 24 hours; "
    "please contact your administrator if you need access sooner."
)


def recent(query, column, interval: str) -> int:
    """Rows of `query` whose `column` (set by the database) falls in the last `interval`, e.g. '1 HOUR'."""
    return query.filter(column >= func.date_sub(func.now(), text(f"INTERVAL {interval}"))).count()


def unregistered_requests(db: Session, mobile: str):
    return db.query(AuditLog.id).filter(
        AuditLog.action == "otp_requested_unregistered",
        func.json_value(AuditLog.new_value, "$.mobile") == mobile,
    )


def login_locked(db: Session, user: User) -> bool:
    lock = db.query(AuditLog.id).filter(AuditLog.action == "otp_login_locked", AuditLog.entity_id == user.id)
    return recent(lock, AuditLog.created_at, f"{LOGIN_LOCK_HOURS} HOUR") > 0


# =============================================================================
# AUTHENTICATION ENDPOINTS (OTP + JWT)
# =============================================================================


def audit_otp_event(
    db: Session,
    request: Request,
    action: str,
    mobile: str,
    *,
    entity_id: str | None = None,
    details: dict | None = None,
) -> None:
    """Writes OTP/auth-related audit events before raising or returning."""
    user = db.query(User).filter(User.mobile == mobile).first()
    write_audit_log(
        db,
        request,
        action=action,
        entity_type="user",
        entity_id=entity_id or (user.id if user else None),
        new_value={"mobile": mobile, **(details or {})},
    )


def audit_auth_event(
    db: Session,
    request: Request,
    action: str,
    *,
    user_id: str | None = None,
    details: dict | None = None,
) -> None:
    """Writes refresh/logout/auth-session audit events."""
    write_audit_log(
        db,
        request,
        action=action,
        entity_type="user",
        entity_id=user_id,
        new_value=details or None,
    )


@router.post("/auth/request-otp")
def request_otp(payload: OTPRequest, request: Request, db: Session = Depends(get_db)):
    """
    Request an OTP for login.
    Validates mobile exists and is active, enforces 60s cooldown, generates 6-digit OTP,
    hashes it with bcrypt, stores in otp_sessions, and sends SMS using the configured provider.
    """
    purpose = (payload.purpose or "login").strip().lower()
    if purpose not in OTP_PURPOSES:
        raise HTTPException(status_code=400, detail="Unsupported OTP purpose")
    sent_reply = {"message": OTP_SENT_MESSAGE, "expires_in": OTP_EXPIRE_MINUTES * 60}

    ip = request.client.host if request.client else None
    if ip:
        from_device = db.query(AuditLog.id).filter(
            AuditLog.action.in_(("otp_requested", "otp_requested_unregistered")), AuditLog.ip_address == ip
        )
        if recent(from_device, AuditLog.created_at, "1 HOUR") >= MAX_LOGIN_OTP_REQUESTS_PER_DEVICE_PER_HOUR:
            audit_otp_event(db, request, action="otp_request_rate_limited", mobile=payload.mobile,
                            details={"limit": "device_per_hour", "purpose": purpose})
            db.commit()
            raise HTTPException(status_code=429, detail="Too many OTP requests from this device. Please try again in an hour.")

    user = db.query(User).filter(User.mobile == payload.mobile, User.is_active == True).first()
    if not user:
        # Same limits and replies as for a staff number, but no code and no SMS.
        earlier = unregistered_requests(db, payload.mobile)
        if recent(earlier, AuditLog.created_at, f"{OTP_COOLDOWN_SECONDS} SECOND") > 0:
            raise HTTPException(status_code=429, detail="Please wait 60 seconds before requesting a new OTP")
        if recent(earlier, AuditLog.created_at, "1 HOUR") >= MAX_LOGIN_OTPS_PER_NUMBER_PER_HOUR:
            raise HTTPException(status_code=429, detail="Too many OTPs for this number. Please try again in an hour.")
        if recent(earlier, AuditLog.created_at, "1 DAY") >= MAX_LOGIN_OTPS_PER_NUMBER_PER_DAY:
            raise HTTPException(status_code=429, detail="Too many OTPs for this number today. Please try again tomorrow.")
        write_audit_log(db, request, action="otp_requested_unregistered", entity_type="user",
                        new_value={"mobile": payload.mobile, "purpose": purpose})
        db.commit()
        return sent_reply

    if login_locked(db, user):
        audit_otp_event(db, request, action="otp_request_rate_limited", mobile=payload.mobile, entity_id=user.id,
                        details={"limit": "locked_after_wrong_codes", "purpose": purpose})
        db.commit()
        raise HTTPException(status_code=429, detail=LOGIN_LOCKED_DETAIL)

    # Enforce cooldown: an unused code was sent in the last 60 seconds
    if in_cooldown(db, payload.mobile, purpose):
        audit_otp_event(
            db,
            request,
            action="otp_request_rate_limited",
            mobile=payload.mobile,
            entity_id=user.id,
            details={"cooldown_seconds": OTP_COOLDOWN_SECONDS, "purpose": purpose},
        )
        db.commit()
        raise HTTPException(status_code=429, detail="Please wait 60 seconds before requesting a new OTP")

    codes = db.query(OTPSession.id).filter(OTPSession.mobile == payload.mobile, OTPSession.purpose == purpose)
    for interval, limit, detail in (
        ("1 HOUR", MAX_LOGIN_OTPS_PER_NUMBER_PER_HOUR, "Too many OTPs for this number. Please try again in an hour."),
        ("1 DAY", MAX_LOGIN_OTPS_PER_NUMBER_PER_DAY, "Too many OTPs for this number today. Please try again tomorrow."),
    ):
        if recent(codes, OTPSession.created_at, interval) >= limit:
            audit_otp_event(db, request, action="otp_request_rate_limited", mobile=payload.mobile, entity_id=user.id,
                            details={"limit": f"number_per_{interval.split()[1].lower()}", "purpose": purpose})
            db.commit()
            raise HTTPException(status_code=429, detail=detail)

    # Create the code (stored hashed) and text it; the SMS log shows it masked
    expires_at = datetime.now(UTC) + timedelta(minutes=OTP_EXPIRE_MINUTES)
    delivery_ok = send_otp(db, request, payload.mobile, purpose)
    sms_enabled_check = os.getenv("SMS_ENABLED", "true").lower() == "true"
    if not delivery_ok:
        audit_otp_event(
            db,
            request,
            action="otp_delivery_failed",
            mobile=payload.mobile,
            entity_id=user.id,
            details={"purpose": purpose, "provider": "sms_service", "reason": "template_or_delivery_failed"},
        )
        db.commit()
        raise HTTPException(
            status_code=503,
            detail="We could not send the OTP right now. Please try again in a moment.",
        )

    write_audit_log(
        db,
        request,
        action="otp_requested",
        entity_type="user",
        entity_id=user.id,
        new_value={
            "mobile": payload.mobile,
            "purpose": purpose,
            "expires_at": expires_at.isoformat(),
            "delivery_status": "sent" if delivery_ok else "skipped",
            "sms_enabled": sms_enabled_check,
        }
    )
    db.commit()

    return sent_reply


@router.post("/auth/verify-otp")
def verify_otp(payload: OTPVerify, request: Request, response: Response, db: Session = Depends(get_db)):
    """
    Verify OTP and issue JWT tokens.
    Checks the latest unused, unexpired OTP (app/otp.py: 5 wrong tries cancel it).
    On success: marks OTP used, generates JWT access token and opaque refresh token,
    sets HttpOnly cookies, stores refresh token hash in DB.
    """
    purpose = (payload.purpose or "login").strip().lower()
    if purpose not in OTP_PURPOSES:
        raise HTTPException(status_code=400, detail="Unsupported OTP purpose")
    if too_many_wrong_codes(db, request):
        raise HTTPException(status_code=429, detail=WRONG_CODES_DETAIL)

    # Check the code: the 5th wrong try cancels it (app/otp.py)
    try:
        check_otp(db, payload.mobile, purpose, payload.otp)
    except OtpCheckFailed as failure:
        details = {"reason": failure.reason, "purpose": purpose}
        if failure.attempts is not None:
            details.update(attempts=failure.attempts, remaining_attempts=MAX_OTP_ATTEMPTS - failure.attempts)
        audit_otp_event(
            db,
            request,
            action="otp_locked_out" if failure.reason == "max_attempts_reached" else "otp_verification_failed",
            mobile=payload.mobile,
            details=details,
        )
        db.commit()
        if failure.reason == "max_attempts_reached":
            # otp_locked_out means this code was cancelled; the third within a day locks the number.
            user = db.query(User).filter(User.mobile == payload.mobile).first()
            if user and not login_locked(db, user):
                cancelled = db.query(AuditLog.id).filter(AuditLog.action == "otp_locked_out", AuditLog.entity_id == user.id)
                if recent(cancelled, AuditLog.created_at, "1 DAY") >= LOGIN_LOCK_AFTER_CANCELLED_CODES:
                    write_audit_log(db, request, action="otp_login_locked", entity_type="user", entity_id=user.id,
                                    new_value={"mobile": payload.mobile, "hours": LOGIN_LOCK_HOURS})
                    db.commit()
                    raise HTTPException(status_code=429, detail=LOGIN_LOCKED_DETAIL) from None
        raise HTTPException(status_code=failure.status_code, detail=failure.detail) from None

    # Get user
    user = db.query(User).filter(User.mobile == payload.mobile, User.is_active == True).first()
    if not user:
        raise HTTPException(status_code=400, detail="User not found or inactive")

    # Update last_login
    user.last_login = datetime.now(UTC)

    # Generate JWT access token
    access_token = create_access_token(user.id)

    # Generate opaque refresh token and hash it
    refresh_token = generate_refresh_token()
    refresh_token_hash = hash_token(refresh_token)

    # Store refresh token in DB
    refresh_expires = datetime.now(UTC) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    db_refresh_token = RefreshToken(
        user_id=user.id,
        token_hash=refresh_token_hash,
        token_prefix=refresh_token[:8],
        expires_at=refresh_expires
    )
    db.add(db_refresh_token)

    # Generate CSRF token for double-submit cookie pattern
    csrf_token = generate_csrf_token()

    # Set cookies
    cookie_opts = auth_cookie_options()
    response.set_cookie(
        "access_token",
        access_token,
        max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        **cookie_opts
    )
    response.set_cookie(
        "refresh_token",
        refresh_token,
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60,
        **cookie_opts
    )
    # CSRF cookie is NOT HttpOnly so frontend can read it
    response.set_cookie(
        "csrf_token",
        csrf_token,
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60,
        **csrf_cookie_options(),
    )

    # Audit log
    write_audit_log(
        db,
        request,
        action="otp_verified",
        entity_type="user",
        entity_id=user.id,
        new_value={"mobile": payload.mobile, "purpose": purpose, "login_success": True}
    )
    db.commit()

    return {"message": "Login successful"}


@router.post("/auth/refresh")
def refresh_token(
    request: Request,
    response: Response,
    refresh_token: str = Cookie(None),
    db: Session = Depends(get_db),
):
    """
    Refresh access token using refresh token cookie.
    Validates refresh token, issues new access token, optionally rotates refresh token.
    """
    if not refresh_token:
        # Not logged: every visitor who never signed in (patients on the public pages included) gets here when
        # the app checks for a session; that was over half the activity log. Bad or expired tokens are still logged.
        raise HTTPException(status_code=401, detail="No refresh token provided")

    # Find refresh token in DB using prefix for efficient lookup
    # This avoids bcrypt-checking all tokens
    candidate_token = db.query(RefreshToken).filter(
        RefreshToken.token_prefix == refresh_token[:8],
        RefreshToken.revoked == False,
        RefreshToken.expires_at > datetime.now(UTC)
    ).first()

    # Verify the hash of the single candidate token
    if not candidate_token or not verify_token_hash(refresh_token, candidate_token.token_hash):
        audit_auth_event(
            db,
            request,
            action="refresh_failed",
            user_id=candidate_token.user_id if candidate_token else None,
            details={"reason": "invalid_or_expired_refresh_token"},
        )
        db.commit()
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    matching_token = candidate_token

    # Get user
    user = db.query(User).filter(User.id == matching_token.user_id, User.is_active == True).first()
    if not user:
        audit_auth_event(
            db,
            request,
            action="refresh_failed",
            user_id=matching_token.user_id,
            details={"reason": "user_not_found_or_inactive"},
        )
        db.commit()
        raise HTTPException(status_code=401, detail="User not found or inactive")

    # Issue new access token
    new_access_token = create_access_token(user.id)

    # Rotate refresh token (recommended security practice)
    # Mark old token as revoked
    matching_token.revoked = True

    # Generate new refresh token
    new_refresh_token = generate_refresh_token()
    new_refresh_hash = hash_token(new_refresh_token)
    new_expires = datetime.now(UTC) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)

    db_new_token = RefreshToken(
        user_id=user.id,
        token_hash=new_refresh_hash,
        token_prefix=new_refresh_token[:8],
        expires_at=new_expires
    )
    db.add(db_new_token)

    # Set cookies
    cookie_opts = auth_cookie_options()
    response.set_cookie(
        "access_token",
        new_access_token,
        max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        **cookie_opts
    )
    response.set_cookie(
        "refresh_token",
        new_refresh_token,
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60,
        **cookie_opts
    )

    # Rotate CSRF token as well for security
    new_csrf_token = generate_csrf_token()
    response.set_cookie(
        "csrf_token",
        new_csrf_token,
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60,
        **csrf_cookie_options(),
    )

    # Audit log
    write_audit_log(
        db,
        request,
        action="token_refreshed",
        entity_type="user",
        entity_id=user.id
    )
    db.commit()

    return {"message": "Token refreshed", "csrf_token": new_csrf_token}


@router.post("/auth/logout")
def logout(
    request: Request,
    response: Response,
    refresh_token: str = Cookie(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Logout: revoke refresh token and clear cookies.
    """
    if refresh_token:
        # Find and revoke the token using prefix for efficient lookup
        candidate_token = db.query(RefreshToken).filter(
            RefreshToken.token_prefix == refresh_token[:8],
            RefreshToken.revoked == False,
            RefreshToken.expires_at > datetime.now(UTC)
        ).first()

        if candidate_token and verify_token_hash(refresh_token, candidate_token.token_hash):
            candidate_token.revoked = True
            db.commit()

    # Audit log
    write_audit_log(
        db,
        request,
        action="logout",
        entity_type="user",
        entity_id=current_user.id,
        current_user=current_user,
    )
    db.commit()

    # Clear cookies
    cookie_opts = auth_cookie_options()
    response.set_cookie("access_token", "", max_age=0, **cookie_opts)
    response.set_cookie("refresh_token", "", max_age=0, **cookie_opts)
    response.set_cookie(
        "csrf_token", "", max_age=0, **csrf_cookie_options(),
    )

    return {"message": "Logged out successfully"}


@router.get("/me")
def get_me(request: Request, access_token: str = Cookie(None), db: Session = Depends(get_db)):
    """
    Get current user info with roles and permissions.
    Requires valid access_token cookie.
    """
    if not access_token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # Decode and validate JWT
    payload = decode_access_token(access_token)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    user_id = payload.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    # Get user with roles and permissions
    user = db.query(User).options(
        joinedload(User.roles).joinedload(Role.permissions)
    ).filter(User.id == user_id, User.is_active == True).first()

    if not user:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    
    # Extract roles
    roles = [role.name for role in user.roles]

    # Extract permissions (flatten and deduplicate)
    permissions = set()
    for role in user.roles:
        for perm in role.permissions:
            permissions.add(perm.action)

    return MeResponse(
        id=user.id,
        name=user.name,
        mobile=user.mobile,
        center_id=user.center_id,
        roles=roles,
        permissions=list(permissions)
    )
