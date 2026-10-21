"""Lease and device rules shared by the routes: status names, due dates, stock holds, issuing,
returns, extensions and pickup guidance."""

import os
import re
from datetime import date, datetime, UTC, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.models import (
    Center,
    User,
    SKU,
    Asset,
    LeaseRequest,
    LeaseItem,
    LeaseExtension,
    LeaseHandoverVerification,
    SKUBlock,
)
from app.schemas import LeaseRequestOut, LeaseFulfillmentCenterOut
from app.permissions import is_center_scoped_operator


# =============================================================================
# Status mapping helpers (API <-> DB naming)
# =============================================================================
def asset_status_to_db(status: str) -> str:
    if status == "under_repair":
        return "repair"
    return status


def asset_status_to_api(status: str) -> str:
    if status == "repair":
        return "under_repair"
    return status


def lease_status_to_db(status: str) -> str:
    if status == "active":
        return "issued"
    if status == "closed":
        return "returned"
    return status


def lease_status_to_api(status: str) -> str:
    if status in {"issued", "partially_returned"}:
        return "active"
    if status == "returned":
        return "closed"
    return status


def resolve_lease_db_status(current_db_status: str, item_asset_ids: list[str | None]) -> str:
    """Server-authoritative fulfillment status derived from line-item assignment."""
    if current_db_status in {"rejected", "returned", "partially_returned", "expired"}:
        return current_db_status
    if item_asset_ids and all(item_asset_ids):
        return "issued"
    if current_db_status == "issued" and any(asset_id is None for asset_id in item_asset_ids):
        return "approved"
    return current_db_status


def parse_expected_duration_days(expected_duration: str | None) -> int | None:
    """Parse UI duration labels like '1 Week' into a day count."""
    if not expected_duration or not expected_duration.strip():
        return None

    lower = expected_duration.strip().lower()
    match = re.search(r"(\d+)", lower)
    if not match:
        return None

    value = int(match.group(1))
    if "week" in lower:
        return value * 7
    if "month" in lower:
        return value * 30
    if "day" in lower:
        return value
    return value


def compute_due_date(expected_duration: str | None, issued_at: datetime | None = None) -> date | None:
    """Derive a due date from expected duration and issue timestamp."""
    days = parse_expected_duration_days(expected_duration)
    if days is None:
        return None

    issue_date = (issued_at or datetime.now(UTC)).date()
    return issue_date + timedelta(days=days)


# Expected durations a request can ask for (the public form offers exactly these).
REQUEST_DURATIONS = ("1 Week", "2 Weeks", "3 Weeks", "4 Weeks")

INDIA_TIME = timezone(timedelta(hours=5, minutes=30))  # no daylight saving, so a fixed offset is exact
MONTH_CODES = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")


def next_token_number(db: Session, now: datetime | None = None) -> str:
    """Token for a new request, e.g. MF-AUG-0001: the month of the request in India time, then a number
    from the lease_token_seq counter (migration 003), which never resets and never repeats."""
    number = db.execute(text("SELECT NEXT VALUE FOR lease_token_seq")).scalar_one()
    month = MONTH_CODES[(now or datetime.now(UTC)).astimezone(INDIA_TIME).month - 1]
    return f"MF-{month}-{number:04d}"

EXTENSION_DURATION_DAYS = {
    "3 days": 3,
    "1 week": 7,
    "2 weeks": 14,
    "1 month": 30,
}
ACTIVE_LEASE_DB_STATUSES = {"issued", "partially_returned"}

# How long stock stays reserved for an approved request before it is released and the
# request is marked expired (see app.jobs.reminders.release_expired_blocks).
PICKUP_WINDOW_HOURS = int(os.getenv("PICKUP_WINDOW_HOURS", "72"))
if PICKUP_WINDOW_HOURS <= 0:
    raise RuntimeError("PICKUP_WINDOW_HOURS must be a positive number of hours")
EXPIRED_REQUEST_DETAIL = (
    "The pickup window for this request has expired. "
    "An approver must re-approve it before devices can be issued."
)


def available_at(db: Session, sku_id: str, center_id: str | None) -> int:
    """Units of a model free to promise at a center: available devices minus other requests' holds."""
    if not center_id:
        return 0
    row = db.execute(
        text("SELECT available_count FROM sku_stock_by_center WHERE sku_id = :sku_id AND center_id = :center_id"),
        {"sku_id": sku_id, "center_id": center_id},
    ).first()
    return int(row[0]) if row and row[0] else 0


def reserve_stock(
    db: Session, lease: LeaseRequest, lines: list[tuple[str, str | None]], release_at: datetime | None
) -> int:
    """Hold one available unit per (model, pickup center) line; a line without a center uses the request's center.
    Returns the number of holds added."""
    created = 0
    for sku_id, center_id in lines:
        center_id = center_id or lease.preferred_center_id
        if available_at(db, sku_id, center_id) > 0:
            db.add(
                SKUBlock(
                    lease_request_id=lease.id,
                    sku_id=sku_id,
                    center_id=center_id,
                    status="blocked",
                    release_at=release_at
                )
            )
            db.flush()  # so the next line sees this hold in sku_stock_by_center
            created += 1
    return created


# Devices are handed over only after the person collecting them reads out an OTP sent to the request's
# mobile (see app.routers.handover). The accepted OTP lets that staff member issue devices once, within this time.
HANDOVER_VERIFICATION_MINUTES = 30
HANDOVER_OTP_REQUIRED_DETAIL = (
    "Verify the OTP sent to the requester's mobile before issuing devices. "
    "An OTP is good for one handover, within 30 minutes."
)


def has_devices_to_issue(db: Session, lease: LeaseRequest) -> bool:
    """True if devices can be issued against the request now: approved, or issued with lines still waiting."""
    if lease.status == "approved":
        return True
    if lease.status != "issued":
        return False
    return db.query(LeaseItem.id).filter(
        LeaseItem.lease_request_id == lease.id, LeaseItem.asset_id.is_(None)
    ).first() is not None


def use_handover_verification(db: Session, lease: LeaseRequest, current_user: User) -> LeaseHandoverVerification:
    """Take the staff member's unused OTP verification for this request, or refuse the issue (HTTP 428).
    It is marked used in the caller's transaction, so an issue that fails leaves it usable."""
    now = datetime.now(UTC).replace(tzinfo=None)
    verification = (
        db.query(LeaseHandoverVerification)
        .filter(
            LeaseHandoverVerification.lease_request_id == lease.id,
            LeaseHandoverVerification.verified_by == current_user.id,
            LeaseHandoverVerification.used_at.is_(None),
            LeaseHandoverVerification.expires_at > now,
        )
        .order_by(LeaseHandoverVerification.verified_at)
        .with_for_update()
        .first()
    )
    if not verification:
        raise HTTPException(status_code=428, detail=HANDOVER_OTP_REQUIRED_DETAIL)
    verification.used_at = now
    return verification


def lease_devices(db: Session, lease: LeaseRequest, lines: list[dict], current_user: User) -> None:
    """Check the devices newly issued on a request and mark them leased in the same transaction as the update."""
    asset_ids = [line["asset_id"] for line in lines]
    if len(set(asset_ids)) != len(asset_ids):
        raise HTTPException(status_code=400, detail="The same device was selected for more than one line")
    center_scoped = is_center_scoped_operator(current_user, db)
    assets: list[Asset] = []
    for line in lines:
        asset = db.get(Asset, line["asset_id"])
        if not asset or not asset.is_active:
            raise HTTPException(status_code=400, detail="Selected device was not found")
        if asset.sku_id != line["sku_id"]:
            raise HTTPException(status_code=400, detail=f"Device {asset.serial_number} is not the requested model")
        if center_scoped and asset.center_id != current_user.center_id:
            raise HTTPException(status_code=403, detail=f"Device {asset.serial_number} is not at your center")
        if asset.status != "available":
            raise HTTPException(
                status_code=400,
                detail=f"Device {asset.serial_number} is not available ({asset_status_to_api(asset.status)})",
            )
        held_elsewhere = db.query(LeaseItem.id).filter(
            LeaseItem.asset_id == asset.id,
            LeaseItem.returned_at.is_(None),
            LeaseItem.lease_request_id != lease.id,
        ).first()
        if held_elsewhere:
            raise HTTPException(status_code=400, detail=f"Device {asset.serial_number} is already issued on another request")
        assets.append(asset)
    for asset in assets:
        asset.status = "leased"


# What a returned device becomes for each condition offered on the return screen.
RETURN_CONDITION_ASSET_STATUS = {
    "Good": "available",
    "Minor Damage": "available",
    "Major Damage": "repair",
    "Needs Repair": "repair",
}
# Requests that can have devices out: issued, partly returned, or approved with only some lines issued.
RETURNABLE_LEASE_DB_STATUSES = {"approved", "issued", "partially_returned"}


def settle_lease_after_return(db: Session, lease: LeaseRequest, lines: list[LeaseItem]) -> int:
    """Set a request's status and due date after devices come back, and return how many are still out.

    `lines` must be all of the request's lines, with this return already recorded on them.
    The request's notes are never touched.
    """
    still_out = [line for line in lines if line.asset_id and line.returned_at is None]
    if still_out:
        # A partly issued request stays approved so its remaining lines can still be issued.
        if lease.status != "approved":
            lease.status = "partially_returned"
        due_dates = [line.due_date for line in still_out if line.due_date]
        if due_dates:
            lease.due_date = max(due_dates)
        return len(still_out)
    lease.status = "returned"
    db.query(SKUBlock).filter(
        SKUBlock.lease_request_id == lease.id,
        SKUBlock.status == "blocked"
    ).update({
        "status": "released",
        "release_reason": "approved_collected",
        "release_at": datetime.now(UTC).replace(tzinfo=None)
    }, synchronize_session=False)
    return 0


def describe_return_condition(condition: str, checklist: list[str], notes: str | None) -> str:
    parts = [condition]
    if checklist:
        parts.append("Checked: " + ", ".join(checklist))
    if notes:
        parts.append("Notes: " + notes)
    return "; ".join(parts)


def parse_extension_duration_days(requested_duration: str) -> int | None:
    """Parse supported extension labels into a server-authoritative day count."""
    if not requested_duration or not requested_duration.strip():
        return None
    return EXTENSION_DURATION_DAYS.get(requested_duration.strip().lower())


def normalize_person_name(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").strip()).casefold()


def active_lease_items(db: Session, lease_request_id: str) -> list[LeaseItem]:
    return (
        db.query(LeaseItem)
        .filter(
            LeaseItem.lease_request_id == lease_request_id,
            LeaseItem.asset_id.is_not(None),
            LeaseItem.returned_at.is_(None),
        )
        .all()
    )


def latest_extension_summary(db: Session, lease_request_id: str) -> dict | None:
    latest = (
        db.query(LeaseExtension)
        .filter(LeaseExtension.lease_request_id == lease_request_id)
        .order_by(LeaseExtension.requested_at.desc())
        .first()
    )
    if not latest:
        return None
    return {
        "id": latest.id,
        "status": latest.status,
        "requested_duration": latest.requested_duration,
        "requested_days": latest.requested_days,
        "requested_due_date": latest.requested_due_date,
        "current_due_date": latest.current_due_date,
        "approved_due_date": latest.approved_due_date,
        "requested_at": latest.requested_at,
        "reviewed_at": latest.reviewed_at,
        "reviewed_by": latest.reviewed_by,
    }


def extension_history_summary(db: Session, lease_request_id: str) -> list[dict]:
    rows = (
        db.query(LeaseExtension)
        .filter(LeaseExtension.lease_request_id == lease_request_id)
        .order_by(LeaseExtension.requested_at.desc())
        .all()
    )
    return [
        {
            "id": row.id,
            "status": row.status,
            "requested_duration": row.requested_duration,
            "requested_days": row.requested_days,
            "requested_due_date": row.requested_due_date,
            "current_due_date": row.current_due_date,
            "approved_due_date": row.approved_due_date,
            "requested_at": row.requested_at,
            "reviewed_at": row.reviewed_at,
            "reviewed_by": row.reviewed_by,
            "reason": row.reason,
            "rejection_reason": row.rejection_reason,
        }
        for row in rows
    ]


MAX_APPROVED_EXTENSIONS_PER_LEASE = 2


def count_approved_extensions(db: Session, lease: LeaseRequest) -> int:
    return (
        db.query(LeaseExtension)
        .filter(
            LeaseExtension.lease_request_id == lease.id,
            LeaseExtension.status == "approved",
        )
        .count()
    )


def evaluate_extension_eligibility(
    db: Session,
    lease: LeaseRequest,
    *,
    ignore_extension_id: str | None = None,
) -> tuple[bool, str, bool]:
    """
    Returns (eligible, reason, pending_exists) for public/staff lease extension flows.
    """
    pending_query = db.query(LeaseExtension).filter(
        LeaseExtension.lease_request_id == lease.id,
        LeaseExtension.status == "pending",
    )
    if ignore_extension_id:
        pending_query = pending_query.filter(LeaseExtension.id != ignore_extension_id)
    pending_exists = pending_query.first() is not None
    if pending_exists:
        return False, "An extension request is already pending for this token.", True

    if count_approved_extensions(db, lease) >= MAX_APPROVED_EXTENSIONS_PER_LEASE:
        return False, f"This lease has reached the maximum allowed extensions ({MAX_APPROVED_EXTENSIONS_PER_LEASE}).", False

    if lease.status not in ACTIVE_LEASE_DB_STATUSES:
        return False, "Extensions are available only for active leases.", False

    if lease.due_date is None:
        return False, "This lease does not have a due date yet.", False

    active_items = active_lease_items(db, lease.id)
    if not active_items:
        return False, "All issued items on this lease have already been returned.", False

    today = datetime.now(UTC).date()
    if lease.due_date > today + timedelta(days=7):
        return False, "Extension requests open only within 7 days of the due date.", False

    if any(item.due_date is None for item in active_items):
        return False, "This lease has active items without persisted due dates.", False

    return True, "Eligible for extension request.", False

# --- Lease request/token APIs ---
def normalize_public_tracking_mobile(mobile: str) -> str | None:
    """Normalize common Indian phone input formats to a 10-digit mobile number."""
    digits_only = re.sub(r"\D", "", mobile or "")
    if len(digits_only) == 12 and digits_only.startswith("91"):
        digits_only = digits_only[2:]
    elif len(digits_only) == 11 and digits_only.startswith("0"):
        digits_only = digits_only[1:]
    return digits_only if re.fullmatch(r"\d{10}", digits_only) else None


def build_fulfillment_plan(db: Session, lease_request_id: str) -> tuple[list[dict], str | None]:
    """Determine which centers can currently fulfill a request based on assigned assets and local stock."""
    item_rows = db.execute(
        select(
            LeaseItem.sku_id,
            SKU.name,
            LeaseItem.quantity_requested,
            LeaseItem.asset_id,
            LeaseItem.pickup_center_id,
        )
        .join(SKU, SKU.id == LeaseItem.sku_id)
        .where(LeaseItem.lease_request_id == lease_request_id)
    ).all()
    if not item_rows:
        return [], None

    assigned_asset_ids = [asset_id for _, _, _, asset_id, _ in item_rows if asset_id]
    assigned_assets: dict[str, Asset] = {}
    if assigned_asset_ids:
        assigned_assets = {
            asset.id: asset
            for asset in db.query(Asset).filter(Asset.id.in_(assigned_asset_ids)).all()
        }

    pending_sku_ids = list({sku_id for sku_id, _, _, asset_id, _ in item_rows if not asset_id})
    availability_by_sku: dict[str, dict[str, int]] = {}
    if pending_sku_ids:
        availability_rows = db.execute(
            select(Asset.sku_id, Asset.center_id, func.count(Asset.id))
            .where(
                Asset.status == "available",
                Asset.sku_id.in_(pending_sku_ids),
                Asset.center_id.is_not(None),
            )
            .group_by(Asset.sku_id, Asset.center_id)
        ).all()
        for sku_id, center_id, count in availability_rows:
            if not center_id:
                continue
            availability_by_sku.setdefault(sku_id, {})[center_id] = int(count)

    center_name_by_id = {center.id: center.name for center in db.query(Center).all()}
    centers: dict[str, dict] = {}

    def add_center_assignment(center_id: str | None, sku_name: str, quantity: int) -> None:
        if not center_id:
            return
        bucket = centers.setdefault(
            center_id,
            {
                "center_id": center_id,
                "center_name": center_name_by_id.get(center_id, "Center"),
                "item_count": 0,
                "item_names": [],
            },
        )
        bucket["item_count"] += quantity
        if sku_name not in bucket["item_names"]:
            bucket["item_names"].append(sku_name)

    shortage_item_names: list[str] = []
    for sku_id, sku_name, quantity_requested, asset_id, pickup_center_id in item_rows:
        if asset_id:
            asset = assigned_assets.get(asset_id)
            lease_center_id = asset.home_center_id if asset and asset.home_center_id else asset.center_id if asset else None
            add_center_assignment(lease_center_id, sku_name, quantity_requested)
            continue

        remaining = quantity_requested
        center_counts = availability_by_sku.setdefault(sku_id, {})
        # The center the requester chose comes first while it still has the device.
        if pickup_center_id and center_counts.get(pickup_center_id, 0) > 0:
            take = min(remaining, center_counts[pickup_center_id])
            add_center_assignment(pickup_center_id, sku_name, take)
            center_counts[pickup_center_id] -= take
            remaining -= take
        sorted_sources = sorted(
            center_counts.items(),
            key=lambda pair: (-pair[1], center_name_by_id.get(pair[0], "Center")),
        )
        for center_id, available_count in sorted_sources:
            if remaining <= 0:
                break
            take = min(remaining, available_count)
            if take <= 0:
                continue
            add_center_assignment(center_id, sku_name, take)
            center_counts[center_id] = max(0, center_counts[center_id] - take)
            remaining -= take

        if remaining > 0 and sku_name not in shortage_item_names:
            shortage_item_names.append(sku_name)

    fulfillment_centers = [
        LeaseFulfillmentCenterOut.model_validate(
            {
                **center_payload,
                "item_names": sorted(center_payload["item_names"]),
            }
        ).model_dump()
        for center_payload in sorted(centers.values(), key=lambda row: row["center_name"].lower())
    ]

    if not fulfillment_centers:
        fulfillment_message = None
    elif len(fulfillment_centers) == 1:
        fulfillment_message = f"Please visit {fulfillment_centers[0]['center_name']} with your Aadhaar to collect your approved device(s)."
    else:
        center_names = ", ".join(center["center_name"] for center in fulfillment_centers[:-1])
        center_names = (
            f"{center_names}, and {fulfillment_centers[-1]['center_name']}"
            if len(fulfillment_centers) > 2
            else f"{fulfillment_centers[0]['center_name']} and {fulfillment_centers[1]['center_name']}"
        )
        fulfillment_message = f"Please visit {center_names} with your Aadhaar to collect your approved device(s)."

    if shortage_item_names:
        shortage_text = ", ".join(shortage_item_names)
        fulfillment_message = (
            f"{fulfillment_message} Some item(s) are still awaiting stock: {shortage_text}."
            if fulfillment_message
            else f"Some item(s) are still awaiting stock: {shortage_text}."
        )

    return fulfillment_centers, fulfillment_message


def center_names_by_id(db: Session) -> dict[str, str]:
    return {center_id: name for center_id, name in db.query(Center.id, Center.name).all()}


def fulfillment_plan_for(db: Session, req: LeaseRequest) -> tuple[list[dict], str | None]:
    """Pickup guidance for display: only pending and approved requests still have devices to collect."""
    if req.status not in {"pending", "approved"}:
        return [], None
    return build_fulfillment_plan(db, req.id)


def fulfillment_center_names(fulfillment_centers: list[dict]) -> str:
    """Render center names for SMS and UI copy."""
    names = [center["center_name"] for center in fulfillment_centers if center.get("center_name")]
    if not names:
        return "our centers"
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return f"{names[0]} and {names[1]}"
    return f"{', '.join(names[:-1])}, and {names[-1]}"


def build_public_lease_lookup_result(db: Session, req: LeaseRequest, *, include_rejection_reasons: bool = False) -> dict:
    """Serialize a lease request with public tracking metadata and line items.

    Rejection reasons (of the request and of its extension requests) are left out unless the caller is staff.
    """
    sku_rows = db.execute(
        select(
            LeaseItem.lease_request_id,
            LeaseItem.sku_id,
            SKU.name,
            LeaseItem.quantity_requested,
            LeaseItem.asset_id,
            LeaseItem.due_date,
            LeaseItem.returned_at,
            LeaseItem.pickup_center_id,
        )
        .join(SKU, SKU.id == LeaseItem.sku_id)
        .where(LeaseItem.lease_request_id == req.id)
    ).all()
    center_names = center_names_by_id(db)
    skus = [row.name for row in sku_rows]
    items = [
        {
            "sku_id": row.sku_id,
            "sku_name": row.name,
            "quantity_requested": row.quantity_requested,
            "asset_id": row.asset_id,
            "due_date": row.due_date,
            "returned_at": row.returned_at,
            "pickup_center_id": row.pickup_center_id,
            "pickup_center_name": center_names.get(row.pickup_center_id),
        }
        for row in sku_rows
    ]
    extension_eligible, extension_reason, pending_extension_request = evaluate_extension_eligibility(db, req)
    fulfillment_centers, fulfillment_message = fulfillment_plan_for(db, req)
    res = {
        **LeaseRequestOut.model_validate(req).model_dump(),
        "status": lease_status_to_api(req.status),
        "skus": skus,
        "items": items,
        "fulfillment_centers": fulfillment_centers,
        "fulfillment_message": fulfillment_message,
        "extension_eligible": extension_eligible,
        "extension_eligibility_reason": extension_reason,
        "pending_extension_request": pending_extension_request,
        "latest_extension": latest_extension_summary(db, req.id),
        "extension_history": extension_history_summary(db, req.id),
    }

    if not include_rejection_reasons:
        res["rejection_reason"] = None
        for entry in res["extension_history"]:
            entry["rejection_reason"] = None

    # Mask sensitive customer PII fields
    if res.get("mobile"):
        m = res["mobile"]
        res["mobile"] = m[:2] + "*" * (len(m) - 4) + m[-2:] if len(m) >= 4 else "*" * len(m)
    if res.get("aadhar_number"):
        a = res["aadhar_number"]
        res["aadhar_number"] = "*" * (len(a) - 4) + a[-4:] if len(a) >= 4 else "*" * len(a)

    return res
