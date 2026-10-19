"""Staff login: OTP request/verify, session refresh, logout and /me."""

import os
from datetime import datetime, UTC, timedelta

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.models import User, Role, RefreshToken
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
from app.otp import OtpCheckFailed, check_otp, in_cooldown, send_otp

router = APIRouter()


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

    # Validate mobile exists and is active
    user = db.query(User).filter(User.mobile == payload.mobile, User.is_active == True).first()
    if not user:
        raise HTTPException(status_code=400, detail="Invalid mobile number or account inactive")

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

    response_payload = {"message": "OTP sent successfully", "expires_in": OTP_EXPIRE_MINUTES * 60}
    return response_payload


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
        audit_auth_event(
            db,
            request,
            action="refresh_failed",
            details={"reason": "missing_refresh_cookie"},
        )
        db.commit()
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
