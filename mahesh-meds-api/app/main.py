"""FastAPI application: logging, error handlers, CORS, startup jobs and the API routers."""

import os
import re
import logging
import traceback
from datetime import datetime, UTC

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import DEBUG_MODE, IS_PRODUCTION

# Configure logging before the rest of the app is imported.
log_level = logging.WARNING if IS_PRODUCTION else logging.INFO
logging.basicConfig(
    level=log_level,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

logger = logging.getLogger(__name__)

from app.database import SessionLocal  # noqa: E402
from app.models import User, Role  # noqa: E402
from app.scheduler import start_scheduler, stop_scheduler  # noqa: E402


# -----------------------------------------------------------------------------
# API route map (backend endpoint -> frontend usage)
#
# Health:
# - GET /health
#   Used by: deployment/runtime health checks.
#
# Audit:
# - GET /api/v1/audit-logs
#   Used by: admin Activity Ledger (Reports page).
#
# Centers:
# - GET /api/v1/centers
#   Used by: public request form, admin pages, center scope dropdowns.
# - POST /api/v1/centers
#   Used by: admin Centers page (create center).
#
# Users:
# - GET /api/v1/users
#   Used by: login validation, admin Users page, center dashboard manager list.
# - POST /api/v1/users
#   Used by: admin Users page (create user).
# - PATCH /api/v1/users/{user_id}
#   Used by: admin Users page (edit role/center/active state).
# - DELETE /api/v1/users/{user_id}
#   Used by: admin Users page (remove user).
#
# SKUs:
# - GET /api/v1/skus
#   Used by: public request form, inventory/admin pages.
# - POST /api/v1/skus
#   Used by: admin SKU/center stock creation flows.
# - PATCH /api/v1/skus/{sku_id}
#   Used by: admin center inventory "Edit SKU / Add Stock".
#
# Assets:
# - GET /api/v1/assets
#   Used by: dashboards, issue/return workflows, asset listing.
# - POST /api/v1/assets
#   Used by: admin inventory stock creation and asset onboarding.
# - PATCH /api/v1/assets/{asset_id}
#   Used by: issue/return status and center updates.
#
# Lease requests:
# - GET /api/v1/lease-requests
#   Used by: admin/approver/center request list pages.
# - POST /api/v1/lease-requests
#   Used by: public Lease Request form submit.
# - PATCH /api/v1/lease-requests/{lease_id}
#   Used by: approver decisions, issue/return status transitions, item edits.
# - GET /api/v1/lease-requests/by-token/{token}
#   Used by: public status page and center return/issue flow (token lookup).
# - GET /api/v1/lease-requests/by-mobile/{mobile}
#   Used by: public status page when requestor tracks via mobile number.
# - GET /api/v1/lease-requests/by-token/{token}/issue-context/{center_id}
#   Used by: center Issue Device page for per-line availability planning.
# -----------------------------------------------------------------------------

app = FastAPI(title="Mahesh Meds API", version="0.2.0")


@app.get("/health")
@app.get("/api/health")
def health_check():
    return {"status": "ok", "service": "mahesh-meds-api", "timestamp": datetime.now(UTC).isoformat()}


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    # Log the full traceback internally
    logger.error(
        f"Unhandled exception on "
        f"{request.method} {request.url}: "
        f"{traceback.format_exc()}"
    )
    # Return a clean response to the client
    return JSONResponse(
        status_code=500,
        content={
            "detail": "An unexpected error occurred. "
                      "Please try again or contact support."
        }
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    # FastAPI's default answer repeats the submitted value in every error. For a request form carrying photos
    # that is megabytes per missing field, so only where and what is wrong is sent back.
    errors = [
        {key: value for key, value in error.items() if key in ("type", "loc", "msg")}
        for error in exc.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": jsonable_encoder(errors)})


@app.exception_handler(404)
async def not_found_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=404,
        content={"detail": "The requested resource was not found."}
    )


# CORS setup: local defaults only apply in DEBUG mode. Production should set
# CORS_ORIGINS explicitly when the frontend is on a different origin.
DEFAULT_CORS_ORIGINS = ["http://localhost:8080", "http://127.0.0.1:8080"]
cors_origins_env = os.getenv(
    "CORS_ORIGINS",
    ",".join(DEFAULT_CORS_ORIGINS) if DEBUG_MODE else "",
)
cors_origins = [origin.strip() for origin in cors_origins_env.split(",") if origin.strip()]
if DEBUG_MODE and not cors_origins:
    cors_origins = DEFAULT_CORS_ORIGINS
default_local_origin_regex = (
    r"^https?://("
    r"localhost|127\.0\.0\.1|"
    r"10(?:\.\d{1,3}){3}|"
    r"192\.168(?:\.\d{1,3}){2}|"
    r"172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}"
    r")(?::\d+)?$"
)
cors_origin_regex = os.getenv(
    "CORS_ORIGIN_REGEX",
    default_local_origin_regex if DEBUG_MODE else "",
) or None
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_origin_regex=cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    start_scheduler()

    # Bootstrap master admin user from env variables if configured
    bootstrap_admin_mobile = os.getenv("BOOTSTRAP_ADMIN_MOBILE")
    bootstrap_admin_name = os.getenv("BOOTSTRAP_ADMIN_NAME", "System Admin")
    if bootstrap_admin_mobile:
        # Validate that mobile is exactly 10 digits as required by database constraints
        if not re.match(r"^[0-9]{10}$", bootstrap_admin_mobile):
            logger.error("Cannot bootstrap admin: BOOTSTRAP_ADMIN_MOBILE must be exactly 10 digits.")
            return

        db = SessionLocal()
        try:
            # Check if user already exists
            user = db.query(User).filter(User.mobile == bootstrap_admin_mobile).first()
            if not user:
                # Find the master_admin role
                admin_role = db.query(Role).filter(Role.name == "master_admin").first()
                if not admin_role:
                    logger.error("Cannot bootstrap admin: 'master_admin' role not found in database.")
                else:
                    logger.info("Bootstrapping master admin user with mobile %s", bootstrap_admin_mobile)
                    new_admin = User(
                        name=bootstrap_admin_name,
                        mobile=bootstrap_admin_mobile,
                        center_id=None,
                        is_active=True
                    )
                    new_admin.roles.append(admin_role)
                    db.add(new_admin)
                    db.commit()
                    logger.info("Successfully bootstrapped master admin user: %s", bootstrap_admin_name)
        except Exception as e:
            db.rollback()
            logger.exception("Failed to bootstrap master admin user: %s", e)
        finally:
            db.close()


@app.on_event("shutdown")
def _shutdown_scheduler() -> None:
    stop_scheduler()


from app.routers import (  # noqa: E402
    aadhar_photos,
    assets,
    audit,
    auth,
    centers,
    handover,
    lease_extensions,
    lease_requests,
    skus,
    track,
    users,
)

for module in (
    audit, centers, users, skus, assets, lease_requests, aadhar_photos, handover, lease_extensions, auth, track,
):
    app.include_router(module.router)
