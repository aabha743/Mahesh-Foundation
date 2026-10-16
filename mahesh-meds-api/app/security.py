"""Sessions and secrets: JWT access tokens, refresh/OTP hashing, auth cookies and the CSRF check."""

import os
import secrets
import bcrypt
import jwt
from datetime import datetime, UTC, timedelta

from fastapi import Cookie, Header, HTTPException

from app.config import DEBUG_MODE


# --- JWT Configuration ---
JWT_SECRET = os.getenv("JWT_SECRET")
if not JWT_SECRET or len(JWT_SECRET) < 32:
    raise RuntimeError(
        "JWT_SECRET must be at least 32 "
        "characters. Generate one with: "
        "python -c 'import secrets; "
        "print(secrets.token_hex(32))'"
    )
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 15
REFRESH_TOKEN_EXPIRE_DAYS = 7
OTP_EXPIRE_MINUTES = 5
OTP_COOLDOWN_SECONDS = 60
MAX_OTP_ATTEMPTS = 5
OTP_PURPOSES = {"login"}

COOKIE_DOMAIN = os.getenv("COOKIE_DOMAIN", None)  # Set for production (e.g., ".maheshfoundation.org")
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false" if DEBUG_MODE else "true").lower() in ("true", "1", "yes")
COOKIE_SAMESITE = os.getenv("COOKIE_SAMESITE", "lax").lower()
if COOKIE_SAMESITE not in {"lax", "strict", "none"}:
    COOKIE_SAMESITE = "lax"
if COOKIE_SAMESITE == "none" and not COOKIE_SECURE:
    if DEBUG_MODE:
        COOKIE_SAMESITE = "lax"
    else:
        raise RuntimeError("COOKIE_SECURE=true is required when COOKIE_SAMESITE=none")


def auth_cookie_options() -> dict:
    """Shared options for HttpOnly auth cookies."""
    return {
        "httponly": True,
        "secure": COOKIE_SECURE,
        "samesite": COOKIE_SAMESITE,
        "domain": COOKIE_DOMAIN,
        "path": "/",
    }


def csrf_cookie_options() -> dict:
    """Shared options for readable CSRF cookie."""
    return {
        "httponly": False,
        "secure": COOKIE_SECURE,
        "samesite": COOKIE_SAMESITE,
        "domain": COOKIE_DOMAIN,
        "path": "/",
    }


def create_access_token(user_id: str) -> str:
    """Create a JWT access token with user_id and expiration."""
    expire = datetime.now(UTC) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"user_id": user_id, "exp": expire, "type": "access"}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict | None:
    """Decode and validate a JWT access token."""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        if payload.get("type") != "access":
            return None
        return payload
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


def generate_refresh_token() -> str:
    """Generate a cryptographically secure opaque refresh token."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """Hash a token using bcrypt for secure storage."""
    return bcrypt.hashpw(token.encode(), bcrypt.gensalt()).decode()


def verify_token_hash(token: str, token_hash: str) -> bool:
    """Verify a token against its stored bcrypt hash."""
    return bcrypt.checkpw(token.encode(), token_hash.encode())


def hash_otp(otp: str) -> str:
    """Hash an OTP using bcrypt for secure storage."""
    return bcrypt.hashpw(otp.encode(), bcrypt.gensalt()).decode()


def verify_otp_hash(otp: str, otp_hash: str) -> bool:
    """Verify an OTP against its stored bcrypt hash."""
    return bcrypt.checkpw(otp.encode(), otp_hash.encode())


def generate_otp() -> str:
    """Generate a 6-digit OTP."""
    return f"{secrets.randbelow(900000) + 100000:06d}"


def generate_csrf_token() -> str:
    """Generate a CSRF token for double-submit cookie pattern."""
    return secrets.token_urlsafe(32)


def validate_csrf(
    csrf_token: str = Cookie(None, alias="csrf_token"),
    x_csrf_token: str | None = Header(None, alias="X-CSRF-Token"),
) -> None:
    """
    CSRF validation dependency for double-submit cookie pattern.
    Validates that the X-CSRF-Token header matches the csrf_token cookie.
    GET requests are exempt (don't use this dependency for GET endpoints).
    """
    if not csrf_token:
        raise HTTPException(status_code=403, detail="CSRF token cookie missing")

    if not x_csrf_token:
        raise HTTPException(status_code=403, detail="X-CSRF-Token header missing")

    # Use constant-time comparison to prevent timing attacks
    if not secrets.compare_digest(csrf_token, x_csrf_token):
        raise HTTPException(status_code=403, detail="CSRF token mismatch")
