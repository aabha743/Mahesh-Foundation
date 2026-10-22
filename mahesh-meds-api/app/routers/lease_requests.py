"""Lease requests: public token/mobile lookup, the request list, submit, approve/issue updates and returns."""

import logging
import uuid
from datetime import date, datetime, UTC, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import (
    AuditLog,
    Center,
    User,
    SKU,
    Asset,
    LeaseRequest,
    LeaseItem,
    SKUBlock,
)
from app.photo_storage import InvalidPhoto, PhotoStorageError, decode_photo, delete_photo, save_photo
from app.schemas import (
    LeaseRequestCreate,
    LeaseRequestOut,
    LeaseRequestListOut,
    PublicLeaseRequestOut,
    LeaseRequestUpdate,
    LeaseReturnCreate,
    LeaseReturnOut,
)
from app.services.sms import send_template_sms
from app.security import get_track_mobile, validate_csrf
from app.permissions import (
    active_users_with_permission,
    enforce_center_resource_access,
    ensure_can_view_request,
    get_optional_user,
    is_center_scoped_operator,
    require_lease_permission,
    require_permission,
    require_requests_visibility,
)
from app.leasing import (
    EXPIRED_REQUEST_DETAIL,
    PICKUP_WINDOW_HOURS,
    REQUEST_DURATIONS,
    RETURNABLE_LEASE_DB_STATUSES,
    RETURN_CONDITION_ASSET_STATUS,
    asset_status_to_api,
    build_public_lease_lookup_result,
    compute_due_date,
    describe_return_condition,
    fulfillment_plan_for,
    lease_devices,
    lease_status_to_api,
    lease_status_to_db,
    next_token_number,
    normalize_public_tracking_mobile,
    available_at,
    center_names_by_id,
    reserve_stock,
    resolve_lease_db_status,
    settle_lease_after_return,
    use_handover_verification,
)
from app.audit import write_audit_log
from app.notifications import notify_request_approved, notify_request_received, notify_request_rejected

logger = logging.getLogger(__name__)

router = APIRouter()

# Public submissions carry photos, so one device (IP address) may send only this many per hour.
MAX_REQUESTS_PER_DEVICE_PER_HOUR = 10


def discard_photos(names: list[str]) -> None:
    """Remove photos saved for a submission that did not go through."""
    for name in names:
        try:
            delete_photo(name)
        except PhotoStorageError:
            logger.exception("Could not remove photo %s of a failed submission", name)


@router.get("/api/v1/lease-requests/by-token/{token}", response_model=PublicLeaseRequestOut)
def get_lease_request_by_token(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
    viewer: User | None = Depends(get_optional_user),
    track_mobile: str | None = Depends(get_track_mobile),
):
    """Token lookup with request header + line items, for staff or a browser that verified the request's
    mobile by OTP (POST /api/v1/track/verify-otp). Staff also see rejection reasons."""
    req = (
        db.query(LeaseRequest)
        .filter(func.lower(LeaseRequest.token_number) == token.strip().lower())
        .first()
    )
    if not req:
        raise HTTPException(status_code=404, detail="Lease request not found")
    ensure_can_view_request(req.mobile, viewer, track_mobile)
    result = build_public_lease_lookup_result(db, req, include_rejection_reasons=viewer is not None)
    write_audit_log(
        db,
        request,
        action="token_viewed",
        entity_type="token",
        entity_id=req.id,
        center_id=req.preferred_center_id,
        new_value={"token": req.token_number, "status": lease_status_to_api(req.status)},
    )
    db.commit()
    return result


@router.get("/api/v1/lease-requests/by-mobile/{mobile}", response_model=list[PublicLeaseRequestOut])
def get_lease_requests_by_mobile(
    mobile: str,
    request: Request,
    db: Session = Depends(get_db),
    viewer: User | None = Depends(get_optional_user),
    track_mobile: str | None = Depends(get_track_mobile),
):
    """All requests linked to a number, for staff or a browser that verified that number by OTP."""
    normalized_mobile = normalize_public_tracking_mobile(mobile)
    if not normalized_mobile:
        raise HTTPException(status_code=400, detail="Enter a valid 10-digit mobile number")
    ensure_can_view_request(normalized_mobile, viewer, track_mobile)

    requests = (
        db.query(LeaseRequest)
        .filter(LeaseRequest.mobile == normalized_mobile)
        .order_by(LeaseRequest.created_at.desc())
        .all()
    )
    if not requests:
        raise HTTPException(status_code=404, detail="No lease requests found for this mobile number")

    results = [build_public_lease_lookup_result(db, lease_request) for lease_request in requests]
    write_audit_log(
        db,
        request,
        action="mobile_lookup_viewed",
        entity_type="token",
        entity_id=None,
        new_value={"mobile": normalized_mobile, "match_count": len(results)},
    )
    db.commit()
    return results


@router.get("/api/v1/lease-requests/by-token/{token}/issue-context/{center_id}")
def get_issue_context(
    token: str,
    center_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("devices.issue")),
):
    """Issue workflow helper: line-level availability at the queried center."""
    req = (
        db.query(LeaseRequest)
        .filter(func.lower(LeaseRequest.token_number) == token.strip().lower())
        .first()
    )
    if not req:
        raise HTTPException(status_code=404, detail="Lease request not found")
    if not db.get(Center, center_id):
        raise HTTPException(status_code=400, detail="Invalid center_id")
    enforce_center_resource_access(current_user, db, center_id)

    sku_rows = db.execute(
        select(
            LeaseItem.lease_request_id,
            LeaseItem.sku_id,
            SKU.name,
            LeaseItem.quantity_requested,
            LeaseItem.asset_id,
            LeaseItem.due_date,
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
            "pickup_center_id": row.pickup_center_id,
            "pickup_center_name": center_names.get(row.pickup_center_id),
        }
        for row in sku_rows
    ]

    pending_sku_ids = [item["sku_id"] for item in items if not item["asset_id"]]
    availability_by_sku: dict[str, dict[str, int]] = {}
    if pending_sku_ids:
        availability_rows = db.execute(
            select(Asset.sku_id, Asset.center_id, func.count(Asset.id))
            .where(Asset.status == "available", Asset.sku_id.in_(pending_sku_ids), Asset.center_id.is_not(None))
            .group_by(Asset.sku_id, Asset.center_id)
        ).all()
        for sku_id, c_id, count in availability_rows:
            availability_by_sku.setdefault(sku_id, {})[c_id] = int(count)

    centers = db.query(Center).all()
    center_name_by_id = {c.id: c.name for c in centers}

    issue_items = []
    for item in items:
        sku_id = item["sku_id"]
        center_counts = availability_by_sku.get(sku_id, {})
        source_centers = [
            {"center_id": c_id, "center_name": center_name_by_id.get(c_id, "Center"), "available_count": count}
            for c_id, count in center_counts.items()
            if c_id != center_id and count > 0
        ]
        issue_items.append(
            {
                **item,
                "local_available_count": center_counts.get(center_id, 0),
                "source_centers": source_centers,
            }
        )

    write_audit_log(
        db,
        request,
        action="issue_context_viewed",
        entity_type="lease_request",
        entity_id=req.id,
        center_id=center_id,
        new_value={"token": req.token_number, "center_id": center_id},
        current_user=current_user,
    )
    db.commit()

    return {
        **LeaseRequestOut.model_validate(req).model_dump(),
        "status": lease_status_to_api(req.status),
        "skus": skus,
        "items": items,
        "issue_items": issue_items,
    }


@router.get("/api/v1/lease-requests", response_model=list[LeaseRequestListOut])
def list_lease_requests(
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_requests_visibility),
):
    """Lists lease requests with denormalized sku/item arrays for frontend tables."""
    query = db.query(LeaseRequest)
    # Center-specific relevance is now derived from actual asset location/home-center data.
    # if is_center_scoped_operator(current_user, db):
    #     query = query.filter(LeaseRequest.preferred_center_id == current_user.center_id)
    requests = query.order_by(LeaseRequest.created_at.desc()).all()
    write_audit_log(db, request, action="requests_list_viewed", entity_type="lease_request", current_user=current_user)
    db.commit()
    if not requests:
        return []

    request_ids = [r.id for r in requests]
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
        .where(LeaseItem.lease_request_id.in_(request_ids))
    ).all()

    center_names = center_names_by_id(db)
    sku_map: dict[str, list[str]] = {}
    item_map: dict[str, list[dict[str, str | int]]] = {}
    for row in sku_rows:
        sku_map.setdefault(row.lease_request_id, []).append(row.name)
        item_map.setdefault(row.lease_request_id, []).append(
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
        )

    response_rows = []
    for req in requests:
        fulfillment_centers, fulfillment_message = fulfillment_plan_for(db, req)
        response_rows.append(
            {
                **LeaseRequestOut.model_validate(req).model_dump(),
                "status": lease_status_to_api(req.status),
                "skus": sku_map.get(req.id, []),
                "items": item_map.get(req.id, []),
                "fulfillment_centers": fulfillment_centers,
                "fulfillment_message": fulfillment_message,
            }
        )
    return response_rows


@router.post("/api/v1/lease-requests", response_model=LeaseRequestOut)
def create_lease_request(
    payload: LeaseRequestCreate,
    request: Request,
    db: Session = Depends(get_db),
):
    """Creates lease request + lease items and derives fulfillment-aware status (PUBLIC - no auth required)."""
    if not payload.reference_name or not payload.reference_name.strip():
        raise HTTPException(status_code=400, detail="Please provide a referral name.")

    if not payload.reference_mobile:
        raise HTTPException(status_code=400, detail="Please provide the referrer's mobile number.")

    if not payload.patient_name or not payload.patient_name.strip():
        raise HTTPException(status_code=400, detail="Patient name is required.")

    if not payload.delivery_address or not payload.delivery_address.strip():
        raise HTTPException(status_code=400, detail="Delivery address is required.")

    # The closest landmark is optional; store nothing rather than an empty string.
    payload.delivery_landmark = (payload.delivery_landmark or "").strip() or None

    if payload.expected_duration not in REQUEST_DURATIONS:
        raise HTTPException(
            status_code=400,
            detail=f"The maximum expected lease duration is 4 weeks. Allowed values: {', '.join(REQUEST_DURATIONS)}."
        )

    if not payload.items:
        raise HTTPException(status_code=400, detail="Please select at least one device.")
    # Each device is collected from a center the requester chose where it is available. A line without a
    # center (an older form) uses the request's preferred center.
    wanted: dict[tuple[str, str], int] = {}
    for item in payload.items:
        sku = db.get(SKU, item.sku_id)
        if not sku:
            raise HTTPException(status_code=400, detail=f"Invalid sku_id in items: {item.sku_id}")
        item.asset_id = None
        item.pickup_center_id = (item.pickup_center_id or payload.preferred_center_id or "").strip() or None
        if not item.pickup_center_id:
            raise HTTPException(status_code=400, detail=f"Please choose where to collect the {sku.name}.")
        center = db.get(Center, item.pickup_center_id)
        if not center or not center.is_active:
            raise HTTPException(status_code=400, detail=f"Invalid pickup center for the {sku.name}.")
        key = (sku.id, center.id)
        wanted[key] = wanted.get(key, 0) + max(1, item.quantity_requested)
        if available_at(db, sku.id, center.id) < wanted[key]:
            raise HTTPException(
                status_code=409,
                detail=f"The {sku.name} is no longer available at {center.name}. Please choose again.",
            )
    payload.preferred_center_id = payload.items[0].pickup_center_id

    # Aadhaar: both numbers and both card photos (one of each when the requester is the patient), with consent.
    if not payload.aadhar_consent:
        raise HTTPException(status_code=400, detail="Please agree to the Aadhaar consent to submit the request.")
    if payload.patient_is_requester:
        payload.patient_aadhar_number = payload.aadhar_number
    elif not payload.patient_aadhar_number:
        raise HTTPException(status_code=400, detail="The patient's Aadhaar number is required.")
    if not payload.aadhar_photo:
        raise HTTPException(status_code=400, detail="Please add a photo of the requester's Aadhaar card.")
    if not payload.patient_is_requester and not payload.patient_aadhar_photo:
        raise HTTPException(status_code=400, detail="Please add a photo of the patient's Aadhaar card.")
    try:
        photos = [("requester", *decode_photo(payload.aadhar_photo, "requester's Aadhaar photo"))]
        if not payload.patient_is_requester:
            photos.append(("patient", *decode_photo(payload.patient_aadhar_photo, "patient's Aadhaar photo")))
    except InvalidPhoto as error:
        raise HTTPException(status_code=400, detail=str(error)) from None

    ip = request.client.host if request.client else None
    if ip:
        recent = db.query(AuditLog.id).filter(
            AuditLog.action == "request_created",
            AuditLog.ip_address == ip,
            AuditLog.created_at >= func.date_sub(func.now(), text("INTERVAL 1 HOUR")),
        ).count()
        if recent >= MAX_REQUESTS_PER_DEVICE_PER_HOUR:
            write_audit_log(db, request, action="request_rate_limited", entity_type="lease_request",
                            new_value={"limit": "device_per_hour"})
            db.commit()
            raise HTTPException(status_code=429, detail="Too many requests from this device. Please try again in an hour.")

    # Photos first, under the request's id: if storage fails, no request (and no token number) is used up.
    lease_id = str(uuid.uuid4())
    saved: list[str] = []
    try:
        for whose, data, content_type, extension in photos:
            name = f"requests/{lease_id}/{whose}-{uuid.uuid4().hex[:12]}.{extension}"
            save_photo(name, data, content_type)
            saved.append(name)
    except PhotoStorageError:
        logger.exception("Could not save the Aadhaar photos of a new request")
        discard_photos(saved)
        raise HTTPException(
            status_code=503, detail="We could not save the Aadhaar photos right now. Please try again in a moment."
        ) from None

    payload_data = payload.model_dump(
        exclude={"aadhar_photo", "patient_aadhar_photo", "patient_is_requester", "aadhar_consent"}
    )
    items_payload = payload_data.pop("items", [])
    # A public submission is always a new, unreviewed request: any status, review fields or device
    # assignments sent with it are ignored. Only staff approve, reject or issue.
    payload_data.update(status="pending", approval_comments=None, rejection_reason=None)
    payload_data.update(
        id=lease_id,
        aadhar_photo=saved[0],
        patient_aadhar_photo=saved[-1],  # the same photo when the requester is the patient
        aadhar_consent_at=datetime.now(UTC).replace(tzinfo=None),
    )
    try:
        payload_data["token_number"] = next_token_number(db)
    except Exception:
        discard_photos(saved)
        raise
    lease = LeaseRequest(**payload_data)
    db.add(lease)
    try:
        db.flush()
        for item in items_payload:
            db.add(
                LeaseItem(
                    lease_request_id=lease.id,
                    sku_id=item["sku_id"],
                    quantity_requested=item.get("quantity_requested", 1),
                    pickup_center_id=item["pickup_center_id"],
                )
            )

        # Hold each device at the center it will be collected from.
        reserve_stock(db, lease, [(item["sku_id"], item["pickup_center_id"]) for item in items_payload], release_at=None)

        db.commit()
    except IntegrityError:
        db.rollback()
        discard_photos(saved)
        raise HTTPException(status_code=409, detail="Token number already exists") from None
    except Exception:
        db.rollback()
        discard_photos(saved)
        raise
    db.refresh(lease)
    write_audit_log(
        db,
        request,
        action="request_created",
        entity_type="lease_request",
        entity_id=lease.id,
        center_id=None,
        new_value={"token": lease.token_number, "status": lease_status_to_api(lease.status)},
    )
    db.commit()

    notify_request_received(db, lease)
    sku_ids = [item["sku_id"] for item in items_payload]
    skus = db.query(SKU).filter(SKU.id.in_(sku_ids)).all()
    items_str = ", ".join(sku.name for sku in skus) if skus else "N/A"
    for approver in active_users_with_permission("requests.approve", db):
        send_template_sms(
            mobile=approver.mobile,
            event_name="request_submitted_approver",
            variables={
                "requestor_name": lease.requestor_name,
                "items": items_str,
            },
            db=db,
            reference_id=lease.id,
        )

    return {
        **LeaseRequestOut.model_validate(lease).model_dump(),
        "status": lease_status_to_api(lease.status),
    }


@router.patch("/api/v1/lease-requests/{lease_id}", response_model=LeaseRequestOut)
def update_lease_request(
    lease_id: str,
    payload: LeaseRequestUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_lease_permission),
    _: None = Depends(validate_csrf),
):
    """Updates lease request header/items; status is re-derived from line assignments.
    Permission checked dynamically based on action type (approve/reject/edit/issue/collect)."""
    lease = db.get(LeaseRequest, lease_id)
    if not lease:
        raise HTTPException(status_code=404, detail="Lease request not found")
    before = LeaseRequestOut.model_validate(lease).model_dump()
    data = payload.model_dump(exclude_unset=True)
    items_payload = data.pop("items", None)
    existing_items = db.query(LeaseItem).filter(LeaseItem.lease_request_id == lease.id).all()
    resource_center_ids = {lease.preferred_center_id} if lease.preferred_center_id else set()
    relevant_asset_ids = {
        item.asset_id for item in existing_items if item.asset_id
    }
    if items_payload is not None:
        relevant_asset_ids.update(item.get("asset_id") for item in items_payload if item.get("asset_id"))
    if relevant_asset_ids:
        relevant_assets = db.query(Asset).filter(Asset.id.in_(relevant_asset_ids)).all()
        resource_center_ids.update(
            asset.home_center_id or asset.center_id
            for asset in relevant_assets
            if asset.home_center_id or asset.center_id
        )
    enforce_center_resource_access(current_user, db, *resource_center_ids)
    if items_payload is not None:
        for item in items_payload:
            if not db.get(SKU, item["sku_id"]):
                raise HTTPException(status_code=400, detail=f"Invalid sku_id in items: {item['sku_id']}")
            if item.get("pickup_center_id") and not db.get(Center, item["pickup_center_id"]):
                raise HTTPException(status_code=400, detail="Invalid pickup center in items")
    if payload.status == "expired":
        raise HTTPException(status_code=400, detail="Requests are marked expired automatically when the pickup window passes")
    if payload.status == "closed":
        # Closing here would leave the devices recorded as out; returns go through POST /returns.
        raise HTTPException(
            status_code=400,
            detail="A request closes when its last device is taken back on the Return Device screen",
        )
    previous_status = lease.status
    was_expired = previous_status == "expired"
    if was_expired:
        assigns_devices = items_payload is not None and any(item.get("asset_id") for item in items_payload)
        if payload.status not in {"approved", "rejected"} or assigns_devices:
            raise HTTPException(status_code=400, detail=EXPIRED_REQUEST_DETAIL)
    handover_verification_id = None
    if items_payload is not None:
        assigned_before = {item.asset_id for item in existing_items if item.asset_id}
        newly_issued = [item for item in items_payload if item.get("asset_id") and item["asset_id"] not in assigned_before]
        if newly_issued:
            if previous_status not in {"approved", "issued"}:
                raise HTTPException(status_code=400, detail="Devices can only be issued against an approved request")
            # The person collecting the devices must have confirmed the OTP sent to the request's mobile.
            handover_verification_id = use_handover_verification(db, lease, current_user).id
            lease_devices(db, lease, newly_issued, current_user)
    if "status" in data and data["status"] is not None:
        data["status"] = lease_status_to_db(data["status"])
        # "active" also covers a partly returned request; don't turn it back into a fully issued one
        # (that would also send the "devices issued" SMS again).
        if data["status"] == "issued" and previous_status == "partially_returned":
            data["status"] = "partially_returned"
    for key, value in data.items():
        setattr(lease, key, value)
    if items_payload is not None:
        existing_item_by_assignment = {
            (item.sku_id, item.asset_id): item
            for item in existing_items
            if item.asset_id
        }
        # Lines are rewritten below; each keeps the pickup center of the existing line for the same model,
        # in order, unless the update gives one.
        pickup_centers_by_sku: dict[str, list[str | None]] = {}
        for existing in existing_items:
            pickup_centers_by_sku.setdefault(existing.sku_id, []).append(existing.pickup_center_id)
        issued_at_now = datetime.now(UTC).replace(tzinfo=None)
        active_due_dates: list[date] = []
        db.query(LeaseItem).filter(LeaseItem.lease_request_id == lease.id).delete()
        for item in items_payload:
            asset_id = item.get("asset_id")
            previous_item = existing_item_by_assignment.get((item["sku_id"], asset_id)) if asset_id else None
            item_issued_at = previous_item.issued_at if previous_item else None
            item_issued_by = previous_item.issued_by if previous_item else None
            item_due_date = previous_item.due_date if previous_item else None
            item_returned_at = previous_item.returned_at if previous_item else None
            item_returned_to = previous_item.returned_to if previous_item else None
            item_return_center_id = previous_item.return_center_id if previous_item else None
            item_condition_on_return = previous_item.condition_on_return if previous_item else None

            if asset_id and item_due_date is None:
                item_issued_at = issued_at_now
                item_issued_by = current_user.id
                item_due_date = compute_due_date(lease.expected_duration, item_issued_at)
            if asset_id and item_due_date:
                active_due_dates.append(item_due_date)
            carried_centers = pickup_centers_by_sku.get(item["sku_id"], [])
            carried_center = carried_centers.pop(0) if carried_centers else None
            db.add(
                LeaseItem(
                    lease_request_id=lease.id,
                    sku_id=item["sku_id"],
                    quantity_requested=item.get("quantity_requested", 1),
                    asset_id=asset_id,
                    pickup_center_id=item.get("pickup_center_id") or carried_center,
                    issued_at=item_issued_at,
                    issued_by=item_issued_by,
                    due_date=item_due_date,
                    returned_at=item_returned_at,
                    returned_to=item_returned_to,
                    return_center_id=item_return_center_id,
                    condition_on_return=item_condition_on_return,
                )
            )
        lease.status = resolve_lease_db_status(
            lease.status,
            [item.get("asset_id") for item in items_payload],
        )
        lease.due_date = max(active_due_dates) if active_due_dates else None
    elif lease.status not in {"rejected", "returned", "partially_returned", "expired"}:
        lease.status = resolve_lease_db_status(lease.status, [item.asset_id for item in existing_items])
        active_due_dates = [
            item.due_date
            for item in existing_items
            if item.asset_id and item.due_date and item.returned_at is None
        ]
        lease.due_date = max(active_due_dates) if active_due_dates else None

    # Update stock blocks based on request status transitions
    pickup_deadline = datetime.now(UTC).replace(tzinfo=None) + timedelta(hours=PICKUP_WINDOW_HOURS)
    if was_expired and lease.status == "approved":
        # The old holds were released when the request expired, so re-approval reserves afresh.
        db.flush()
        open_lines = db.query(LeaseItem).filter(LeaseItem.lease_request_id == lease.id, LeaseItem.asset_id.is_(None)).all()
        reserve_stock(db, lease, [(line.sku_id, line.pickup_center_id) for line in open_lines], release_at=pickup_deadline)
    if lease.status == "approved":
        db.query(SKUBlock).filter(
            SKUBlock.lease_request_id == lease.id,
            SKUBlock.status == "blocked"
        ).update({
            "release_at": pickup_deadline
        }, synchronize_session=False)
    elif lease.status == "rejected":
        db.query(SKUBlock).filter(
            SKUBlock.lease_request_id == lease.id,
            SKUBlock.status == "blocked"
        ).update({
            "status": "released",
            "release_reason": "rejected",
            "release_at": datetime.now(UTC).replace(tzinfo=None)
        }, synchronize_session=False)
    elif lease.status in {"issued", "returned", "partially_returned"}:
        db.query(SKUBlock).filter(
            SKUBlock.lease_request_id == lease.id,
            SKUBlock.status == "blocked"
        ).update({
            "status": "released",
            "release_reason": "approved_collected",
            "release_at": datetime.now(UTC).replace(tzinfo=None)
        }, synchronize_session=False)

    db.commit()
    db.refresh(lease)
    # Only a real change of status counts: a partial issue also sends status "approved".
    became_approved = previous_status in {"pending", "expired"} and lease.status == "approved"
    became_rejected = previous_status != "rejected" and lease.status == "rejected"
    action = "request_updated"
    if became_approved:
        action = "approve_request"
    elif became_rejected:
        action = "reject_request"
    write_audit_log(
        db,
        request,
        action=action,
        entity_type="lease_request",
        entity_id=lease.id,
        center_id=current_user.center_id,
        old_value={**before, "token": before.get("token_number")},
        new_value={
            **LeaseRequestOut.model_validate(lease).model_dump(),
            "token": lease.token_number,
            **({"handover_verification_id": handover_verification_id} if handover_verification_id else {}),
        },
        current_user=current_user,
    )
    db.commit()

    if became_approved:
        notify_request_approved(db, lease)
    elif became_rejected:
        notify_request_rejected(db, lease)

    if before.get("status") != "issued" and lease.status == "issued":
        db_items = db.query(LeaseItem).filter(LeaseItem.lease_request_id == lease.id).all()
        items_names = [item.sku.name for item in db_items if item.sku]
        items_str = ", ".join(items_names) if items_names else "N/A"
        due_date_str = lease.due_date.strftime("%B %d, %Y") if lease.due_date else "N/A"
        send_template_sms(
            mobile=lease.mobile,
            event_name="device_issued_user",
            variables={
                "token_number": lease.token_number,
                "items": items_str,
                "due_date": due_date_str,
            },
            db=db,
            reference_id=lease.id,
        )

    return {
        **LeaseRequestOut.model_validate(lease).model_dump(),
        "status": lease_status_to_api(lease.status),
    }


@router.post("/api/v1/lease-requests/{lease_id}/returns", response_model=LeaseReturnOut)
def return_lease_devices(
    lease_id: str,
    payload: LeaseReturnCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("devices.collect")),
    _: None = Depends(validate_csrf),
):
    """Takes back devices issued on a request in one transaction: records each return on its line, puts the
    devices back in stock (or under repair), and sets the request to partly returned or returned."""
    lease = db.query(LeaseRequest).filter(LeaseRequest.id == lease_id).with_for_update().first()
    if not lease:
        raise HTTPException(status_code=404, detail="Lease request not found")
    asset_status = RETURN_CONDITION_ASSET_STATUS.get(payload.condition)
    if asset_status is None:
        raise HTTPException(status_code=400, detail="Choose the condition of the returned devices")
    if lease.status not in RETURNABLE_LEASE_DB_STATUSES:
        raise HTTPException(status_code=400, detail="This request has no devices out")
    asset_ids = [item.asset_id for item in payload.items]
    if len(set(asset_ids)) != len(asset_ids):
        raise HTTPException(status_code=400, detail="The same device was selected more than once")

    center_scoped = is_center_scoped_operator(current_user, db)
    return_center_id = payload.center_id or current_user.center_id
    if center_scoped and return_center_id != current_user.center_id:
        raise HTTPException(status_code=403, detail="Devices can only be received at your center")
    if not return_center_id or not db.get(Center, return_center_id):
        raise HTTPException(status_code=400, detail="Choose the center receiving the devices")

    lines = db.query(LeaseItem).filter(LeaseItem.lease_request_id == lease.id).with_for_update().all()
    open_line_by_asset = {line.asset_id: line for line in lines if line.asset_id and line.returned_at is None}
    checklist = [entry.strip() for entry in payload.checklist if entry.strip()]
    notes = (payload.notes or "").strip() or None
    condition_text = describe_return_condition(payload.condition, checklist, notes)
    returned_at = datetime.now(UTC).replace(tzinfo=None)
    returned: list[dict] = []
    for item in payload.items:
        line = open_line_by_asset.get(item.asset_id)
        asset = db.get(Asset, item.asset_id) if line else None
        if not line or not asset:
            raise HTTPException(status_code=400, detail="A selected device is not out on this request")
        if item.serial_number.strip().upper() != asset.serial_number.upper():
            raise HTTPException(status_code=400, detail=f"The serial entered does not match device {asset.serial_number}")
        if center_scoped and (asset.home_center_id or asset.center_id) != current_user.center_id:
            raise HTTPException(status_code=403, detail=f"Device {asset.serial_number} does not belong to your center")
        line.returned_at = returned_at
        line.returned_to = current_user.id
        line.return_center_id = return_center_id
        line.condition_on_return = condition_text
        asset.status = asset_status
        asset.center_id = return_center_id
        if asset_status == "repair":
            repair_note = f"{returned_at:%Y-%m-%d} returned on token {lease.token_number}: {condition_text}"
            asset.notes = f"{asset.notes}\n{repair_note}" if asset.notes else repair_note
        returned.append({"asset_id": asset.id, "serial_number": asset.serial_number, "status": asset_status_to_api(asset.status)})

    previous_status = lease.status
    still_out = settle_lease_after_return(db, lease, lines)
    write_audit_log(
        db,
        request,
        action="devices_returned",
        entity_type="lease_request",
        entity_id=lease.id,
        center_id=return_center_id,
        old_value={"status": previous_status, "token": lease.token_number},
        new_value={
            "status": lease.status,
            "token": lease.token_number,
            "devices": returned,
            "condition": payload.condition,
            "checklist": checklist,
            "notes": notes,
            "still_out": still_out,
        },
        current_user=current_user,
    )
    db.commit()
    return {
        "lease_id": lease.id,
        "status": lease_status_to_api(lease.status),
        "returned": returned,
        "still_out": still_out,
    }
