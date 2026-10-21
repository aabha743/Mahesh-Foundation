"""SMS for request and extension events, on the DLT templates listed in app.services.sms.

SMS_NEW_TEMPLATES (default on): use the templates registered in October 2026 (request received with a link, referrer
notice, tracking/handover OTP, extension received and approved). Turned off, everything goes out on the earlier
templates, so a problem with the new ones can be undone with one setting.
SMS_APPROVED_WITH_CONTACT (default off): send the approval SMS that names the pickup center's manager and number.
It stays off until the DLT operator confirms a phone number may be sent in a normal (alphanumeric) variable;
until then the earlier approval SMS is used.
"""

import os
from datetime import date

from sqlalchemy.orm import Session

from app.leasing import build_fulfillment_plan, fulfillment_center_names
from app.models import LeaseExtension, LeaseRequest
from app.permissions import active_users_with_role
from app.services.sms import send_template_sms

# The DLT portal accepts at most this many characters in one variable.
DLT_VARIABLE_MAX = 40


def _setting(name: str, default: str) -> bool:
    return os.getenv(name, default).strip().lower() == "true"


def new_templates() -> bool:
    return _setting("SMS_NEW_TEMPLATES", "true")


def approved_with_contact() -> bool:
    return _setting("SMS_APPROVED_WITH_CONTACT", "false")


def site_url() -> str:
    return os.getenv("PUBLIC_SITE_URL", "https://maheshfoundation-medical.com").strip().rstrip("/")


def track_url(token: str) -> str:
    """Link to the request's status page (the visitor still verifies the mobile by OTP there)."""
    return f"{site_url()}/track/{token}"


def fit(value: str | None) -> str:
    """A value for one DLT variable: trimmed to the portal's length limit."""
    return (value or "").strip()[:DLT_VARIABLE_MAX].strip()


def sms_date(value: date | None) -> str:
    """Dates in SMS read like '30 Oct 2026' (no comma, so they are valid alphanumeric variables)."""
    return value.strftime("%d %b %Y") if value else "N/A"


def otp_event(purpose: str) -> str:
    """Staff login keeps its own template; tracking and handover codes use the tracking OTP template."""
    return "otp_login" if purpose == "login" or not new_templates() else "mf_tracking_otp"


def notify_request_received(db: Session, lease: LeaseRequest) -> None:
    """To the requester, and to the referrer named on the request (unless that is the requester's own number)."""
    if not new_templates():
        send_template_sms(mobile=lease.mobile, event_name="request_submitted_user",
                          variables={"token_number": lease.token_number}, db=db, reference_id=lease.id)
        return
    send_template_sms(
        mobile=lease.mobile,
        event_name="mf_request_received",
        variables={"token_number": lease.token_number, "track_url": track_url(lease.token_number)},
        db=db,
        reference_id=lease.id,
    )
    if lease.reference_mobile and lease.reference_mobile != lease.mobile:
        send_template_sms(
            mobile=lease.reference_mobile,
            event_name="mf_referrer_notice",
            variables={"requestor_name": fit(lease.requestor_name), "token_number": lease.token_number},
            db=db,
            reference_id=lease.id,
        )


def _earlier_approval_sms(db: Session, lease: LeaseRequest, centers: list[dict]) -> None:
    center_names = fulfillment_center_names(centers) or "our center"
    send_template_sms(
        mobile=lease.mobile,
        event_name="request_approved_user",
        variables={"token_number": lease.token_number, "center_name": center_names, "pickup_guidance": f"{center_names} team"},
        db=db,
        reference_id=lease.id,
    )


def notify_request_approved(db: Session, lease: LeaseRequest) -> None:
    """To the requester (one SMS per pickup center when the contact SMS is on) and to each center's managers."""
    centers, _ = build_fulfillment_plan(db, lease.id)
    managers_by_center = {
        center["center_id"]: sorted(
            active_users_with_role("center_manager", db, center_id=center["center_id"]), key=lambda user: user.name or ""
        )
        for center in centers
    }

    if new_templates() and approved_with_contact() and centers:
        without_manager = []
        for center in centers:
            managers = managers_by_center[center["center_id"]]
            if not managers:
                without_manager.append(center)
                continue
            contact = managers[0]  # the first by name when a center has several
            send_template_sms(
                mobile=lease.mobile,
                event_name="mf_request_approved",
                variables={
                    "token_number": lease.token_number,
                    "center_name": fit(center["center_name"]),
                    "contact_name": fit(contact.name),
                    "contact_mobile": contact.mobile,
                    "track_url": track_url(lease.token_number),
                },
                db=db,
                reference_id=lease.id,
            )
        if without_manager:
            # No one to name at these centers: the earlier SMS points to the center team.
            _earlier_approval_sms(db, lease, without_manager)
    else:
        _earlier_approval_sms(db, lease, centers)

    for center in centers:
        for manager in managers_by_center[center["center_id"]]:
            send_template_sms(
                mobile=manager.mobile,
                event_name="request_approved_center_manager",
                variables={
                    "token_number": lease.token_number,
                    "requestor_name": lease.requestor_name,
                    "center_name": center["center_name"],
                },
                db=db,
                reference_id=lease.id,
            )


def notify_extension_received(db: Session, lease: LeaseRequest) -> None:
    if new_templates():
        send_template_sms(mobile=lease.mobile, event_name="mf_extension_received",
                          variables={"token_number": lease.token_number}, db=db, reference_id=lease.id)


def notify_extension_approved(db: Session, lease: LeaseRequest, extension: LeaseExtension) -> None:
    if new_templates():
        send_template_sms(
            mobile=lease.mobile,
            event_name="mf_extension_approved",
            variables={"token_number": lease.token_number, "due_date": sms_date(extension.approved_due_date)},
            db=db,
            reference_id=lease.id,
        )
