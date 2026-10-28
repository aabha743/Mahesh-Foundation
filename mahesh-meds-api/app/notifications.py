"""SMS for request and extension events, on the DLT templates listed in app.services.sms.

SMS_NEW_TEMPLATES (default on): use the templates registered in October 2026 (the mf_* events in app.services.sms).
Turned off, everything goes out on the earlier templates, so a problem with the new ones can be undone with one setting.
SMS_TEMPLATES_OFF (default empty): comma-separated mf_* events not to use yet, such as templates still awaiting DLT
approval. Each listed event keeps the earlier behaviour: approval and rejection go out on the earlier templates, the
request-received SMS on the earlier one, and the others (referrer notice, expiry, extension messages) are not sent.

Phone numbers in SMS are whitelisted call-back numbers on DLT. The rejection and extension-refusal SMS give the
foundation's number (FOUNDATION_CONTACT_MOBILE); only the approval SMS names the pickup center's manager, so a new
center manager's number must be whitelisted before they are made a center manager.
Links are the site address only (PUBLIC_SITE_URL): that is the one URL whitelisted on DLT, and an SMS with any other
link, even a page on the same site, is accepted by BulkSMS but never delivered.
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
# Who a rejected requester is told to contact on the earlier template (its {contact_info}).
REJECTION_CONTACT = "Mahesh Foundation team"
# The number to call in the rejection and extension-refusal SMS (whitelisted on DLT as a call-back number).
FOUNDATION_CONTACT_MOBILE = "9849001740"


def _setting(name: str, default: str) -> bool:
    return os.getenv(name, default).strip().lower() == "true"


def new_templates() -> bool:
    return _setting("SMS_NEW_TEMPLATES", "true")


def templates_off() -> set[str]:
    return {name.strip().lower() for name in os.getenv("SMS_TEMPLATES_OFF", "").split(",") if name.strip()}


def template_on(event: str) -> bool:
    """Whether one of the new templates is in use: SMS_NEW_TEMPLATES is on and the event is not in SMS_TEMPLATES_OFF."""
    return new_templates() and event not in templates_off()


def site_url() -> str:
    """The link in SMS: the site address whitelisted on DLT, with nothing after it."""
    return os.getenv("PUBLIC_SITE_URL", "https://maheshfoundation-medical.com").strip().rstrip("/")


def fit(value: str | None) -> str:
    """A value for one DLT variable: trimmed to the portal's length limit."""
    return (value or "").strip()[:DLT_VARIABLE_MAX].strip()


def sms_date(value: date | None) -> str:
    """Dates in SMS read like '30 Oct 2026' (no comma, so they are valid alphanumeric variables)."""
    return value.strftime("%d %b %Y") if value else "N/A"


def otp_event(purpose: str) -> str:
    """Staff login keeps its own template; tracking and handover codes use the tracking OTP template."""
    return "otp_login" if purpose == "login" or not template_on("mf_tracking_otp") else "mf_tracking_otp"


def center_managers(db: Session, center_id: str | None) -> list:
    """Active center managers of a center, by name; the first is the one named in SMS."""
    if not center_id:
        return []
    return sorted(active_users_with_role("center_manager", db, center_id=center_id), key=lambda user: user.name or "")


def notify_request_received(db: Session, lease: LeaseRequest) -> None:
    """To the requester, and to the referrer named on the request (unless that is the requester's own number)."""
    if template_on("mf_request_received"):
        send_template_sms(
            mobile=lease.mobile,
            event_name="mf_request_received",
            variables={"token_number": lease.token_number, "site_url": site_url()},
            db=db,
            reference_id=lease.id,
        )
    else:
        send_template_sms(mobile=lease.mobile, event_name="request_submitted_user",
                          variables={"token_number": lease.token_number}, db=db, reference_id=lease.id)
    if template_on("mf_referrer_notice") and lease.reference_mobile and lease.reference_mobile != lease.mobile:
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
    """To the requester (one SMS per pickup center on the new template) and to each center's managers."""
    centers, _ = build_fulfillment_plan(db, lease.id)
    managers_by_center = {center["center_id"]: center_managers(db, center["center_id"]) for center in centers}

    if template_on("mf_request_approved") and centers:
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
                    "site_url": site_url(),
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


def notify_request_rejected(db: Session, lease: LeaseRequest) -> None:
    """Gives the foundation's number to call (the earlier template, when switched back, names the foundation team)."""
    if template_on("mf_request_rejected"):
        send_template_sms(
            mobile=lease.mobile,
            event_name="mf_request_rejected",
            variables={"token_number": lease.token_number, "contact_mobile": FOUNDATION_CONTACT_MOBILE},
            db=db,
            reference_id=lease.id,
        )
        return
    send_template_sms(
        mobile=lease.mobile,
        event_name="request_rejected_user",
        # Rejection reasons are not shared with requesters.
        variables={"token_number": lease.token_number, "contact_info": REJECTION_CONTACT},
        db=db,
        reference_id=lease.id,
    )


def notify_request_expired(db: Session, lease: LeaseRequest) -> None:
    """The pickup window passed without collection: the requester can apply again on the site."""
    if template_on("mf_token_expired"):
        send_template_sms(
            mobile=lease.mobile,
            event_name="mf_token_expired",
            variables={"token_number": lease.token_number, "site_url": site_url()},
            db=db,
            reference_id=lease.id,
        )


def notify_extension_received(db: Session, lease: LeaseRequest) -> None:
    if template_on("mf_extension_received"):
        send_template_sms(mobile=lease.mobile, event_name="mf_extension_received",
                          variables={"token_number": lease.token_number}, db=db, reference_id=lease.id)


def notify_extension_rejected(db: Session, lease: LeaseRequest) -> None:
    """Return date stays as it was; the number to call is the foundation's."""
    if template_on("mf_extension_not_approved"):
        send_template_sms(
            mobile=lease.mobile,
            event_name="mf_extension_not_approved",
            variables={
                "token_number": lease.token_number,
                "due_date": sms_date(lease.due_date),
                "contact_mobile": FOUNDATION_CONTACT_MOBILE,
            },
            db=db,
            reference_id=lease.id,
        )


def notify_extension_approved(db: Session, lease: LeaseRequest, extension: LeaseExtension) -> None:
    if template_on("mf_extension_approved"):
        send_template_sms(
            mobile=lease.mobile,
            event_name="mf_extension_approved",
            variables={"token_number": lease.token_number, "due_date": sms_date(extension.approved_due_date)},
            db=db,
            reference_id=lease.id,
        )
