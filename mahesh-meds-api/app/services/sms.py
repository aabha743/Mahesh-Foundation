import logging
import os
import re

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models import SMSTemplate

logger = logging.getLogger(__name__)

# Provider credentials come only from the environment (.env); there are no fallbacks.
SMS_API_KEY = os.getenv("SMS_API_KEY", "")
SMS_USERNAME = os.getenv("SMS_USERNAME", "")
SMS_SENDER = os.getenv("SMS_SENDER", "MHSFND")
SMS_BASE_URL = os.getenv("SMS_BASE_URL", "http://www.bulksmsapps.com/api/apismsv2.aspx")
SMS_PEID = os.getenv("SMS_PEID", "")
SMS_ENABLED = os.getenv("SMS_ENABLED", "true").lower() == "true"
SMS_TIMEOUT_SECONDS = float(os.getenv("SMS_TIMEOUT_SECONDS", "10"))

SMS_TEMPLATE_SEEDS: list[tuple[str, str, str | None]] = [
    (
        "otp_login",
        "Your OTP for Registration or Login for Marwari Angels-an initiative of Mahesh Foundation is {otp}",
        "1207164430243674445",
    ),
    (
        "request_submitted_user",
        "Your request has been received by Mahesh Foundation’s Medical Equipment services team. Please keep Token: {token_number} for tracking and future communication. - MHSFND",
        "1207178298116878850",
    ),
    (
        "MES_Service_Request",
        "Your request has been received by Mahesh Foundation’s Medical Equipment services team. Please keep Token: {token_number} for tracking and future communication. - MHSFND",
        "1207178298116878850",
    ),
    (
        "request_submitted_approver",
        "New device request received on Mahesh Foundation portal. Requestor: {requestor_name} . Device requested : {items}. Please review in the system. - MHSFND",
        "1207178298810693025",
    ),
    (
        "MES_Approver_Request",
        "New device request received on Mahesh Foundation portal. Requestor: {requestor_name} . Device requested : {items}. Please review in the system. - MHSFND",
        "1207178298810693025",
    ),
    (
        "request_approved_user",
        "Your request has been approved by Mahesh Foundation Medical Equipment services. Token: {token_number}. Please coordinate with {pickup_guidance} for next steps. - MHSFND",
        "1207178298611760659",
    ),
    (
        "MES_User_Request_Approved",
        "Your request has been approved by Mahesh Foundation Medical Equipment services. Token: {token_number}. Please coordinate with {pickup_guidance} for next steps. - MHSFND",
        "1207178298611760659",
    ),
    (
        "request_approved_center_manager",
        "Approved request requires center action. Token: {token_number} . Requestor: {requestor_name} . Please review fulfillment on Mahesh Foundation MES system. - MHSFND",
        "1207178308079756627",
    ),
    (
        "Approved_cm",
        "Approved request requires center action. Token: {token_number} . Requestor: {requestor_name} . Please review fulfillment on Mahesh Foundation MES system. - MHSFND",
        "1207178308079756627",
    ),
    (
        "request_rejected_user",
        "Your request could not be approved by Mahesh Foundation Medical Equipment Services. For any concerns, please contact {contact_info} .",
        "1207178299249716221",
    ),
    (
        "MES_Request_Rejected",
        "Your request could not be approved by Mahesh Foundation Medical Equipment Services. For any concerns, please contact {contact_info} .",
        "1207178299249716221",
    ),
    (
        "device_issued_user",
        "Devices have been issued by Mahesh Foundation Medical Equipment Services against Token: {token_number}. Items: {items}. Expected return date: {due_date}. - MHSFND",
        "1207178299880758060",
    ),
    (
        "MES_Device_Issued",
        "Devices have been issued by Mahesh Foundation Medical Equipment Services against Token: {token_number}. Items: {items}. Expected return date: {due_date}. - MHSFND",
        "1207178299880758060",
    ),
    (
        "return_reminder_7d",
        "Reminder: Devices for Token: {token_number} are due on {due_date} . Please arrange for return to Mahesh Foundation MES center. - MHSFND",
        "1207178308496256310",
    ),
    (
        "return_reminder_3d",
        "Reminder: Devices for Token: {token_number} are due on {due_date} . Please arrange for return to Mahesh Foundation MES center. - MHSFND",
        "1207178308496256310",
    ),
    (
        "return_reminder_1d",
        "Reminder: Devices for Token: {token_number} are due on {due_date} . Please arrange for return to Mahesh Foundation MES center. - MHSFND",
        "1207178308496256310",
    ),
    # Registered on DLT in October 2026 (header MHSFND). Each text must match its registration character for
    # character, double spaces included; tests/test_sms_templates.py checks this. See app/notifications.py.
    (
        "mf_request_received",
        "Mahesh Foundation: Your medical equipment request is received. Token:{token_number} . Track it at {track_url}   - MHSFND",
        "1277179258580359181",
    ),
    (
        # MF_Request_Approved_num: the contact number is a whitelisted call-back number ({#cbn#}).
        "mf_request_approved",
        "Mahesh Foundation: Request {token_number} approved. Collect from {center_name}  within 3 days. Contact {contact_name} {contact_mobile}  . Track your request on: {track_url} - MHSFND",
        "1277179265177418932",
    ),
    (
        "mf_request_rejected",
        "Mahesh Foundation: Request {token_number} could not be approved. For any questions, please call {contact_mobile} . - MHSFND",
        "1277179265313329507",
    ),
    (
        "mf_extension_not_approved",
        "Mahesh Foundation: Your extension request for Token {token_number} could not be approved. Please return the devices by {due_date} or call {contact_mobile} . - MHSFND",
        "1277179265283139892",
    ),
    (
        "mf_token_expired",
        "Mahesh Foundation: Your request of token: {token_number} has expired as it was not collected within 3 days. Please re-apply at {site_url} and get a new token. - MHSFND",
        "1277179265582573786",
    ),
    (
        "mf_tracking_otp",
        "Your OTP is {otp}  to view your Mahesh Foundation medical equipment request. Valid for 5 minutes. Please do not share it with anyone. - MHSFND",
        "1277179258196035097",
    ),
    (
        "mf_referrer_notice",
        "Mahesh Foundation: This is to inform you that {requestor_name}  has listed you as a referrer for medical equipment request {token_number}. - MHSFND",
        "1277179258745423631",
    ),
    (
        "mf_extension_received",
        "Mahesh Foundation: Your extension request for Token: {token_number} has been received and is under consideration . - MHSFND",
        "1277179258409353603",
    ),
    (
        "mf_extension_approved",
        "Mahesh Foundation: Your extension request for Token {token_number} is approved. New return date: {due_date} . - MHSFND",
        "1277179258261227432",
    ),
    (
        "Reminder_overdue",
        "Reminder: Devices for Token: {token_number} are due on {due_date} . Please arrange for return to Mahesh Foundation MES center. - MHSFND",
        "1207178308496256310",
    ),
]


def _ensure_index(db: Session, table_name: str, index_name: str, ddl: str) -> None:
    index_exists = db.execute(
        text(
            """
            SELECT COUNT(*)
            FROM information_schema.statistics
            WHERE table_schema = DATABASE()
              AND table_name = :table_name
              AND index_name = :index_name
            """
        ),
        {"table_name": table_name, "index_name": index_name},
    ).scalar()
    if not index_exists:
        db.execute(text(ddl))


def _ensure_column(db: Session, table_name: str, column_name: str, ddl: str) -> None:
    column_exists = db.execute(
        text(
            """
            SELECT COUNT(*)
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = :table_name
              AND column_name = :column_name
            """
        ),
        {"table_name": table_name, "column_name": column_name},
    ).scalar()
    if not column_exists:
        db.execute(text(ddl))


def ensure_sms_tables(db: Session) -> None:
    if db.info.get("sms_tables_ready"):
        return

    db.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS notifications_log (
              id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
              recipient_mobile VARCHAR(20) NOT NULL,
              message TEXT NOT NULL,
              type VARCHAR(100) NULL,
              reference_id CHAR(36) NULL,
              status VARCHAR(20) NOT NULL,
              error_message TEXT NULL,
              sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )
    db.execute(text("ALTER TABLE notifications_log MODIFY recipient_mobile VARCHAR(20) NOT NULL"))
    db.execute(text("ALTER TABLE notifications_log MODIFY type VARCHAR(100) NULL"))
    _ensure_column(
        db,
        "notifications_log",
        "reference_id",
        "ALTER TABLE notifications_log ADD COLUMN reference_id CHAR(36) NULL",
    )
    db.execute(text("ALTER TABLE notifications_log MODIFY status VARCHAR(20) NOT NULL"))
    _ensure_index(
        db,
        "notifications_log",
        "idx_notif_reference_type_day",
        "CREATE INDEX idx_notif_reference_type_day ON notifications_log (reference_id, type, sent_at)",
    )
    _ensure_index(
        db,
        "notifications_log",
        "idx_notif_mobile_type_day",
        "CREATE INDEX idx_notif_mobile_type_day ON notifications_log (recipient_mobile, type, sent_at)",
    )

    db.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS sms_templates (
              id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
              event_name VARCHAR(100) UNIQUE NOT NULL,
              template_text TEXT NOT NULL,
              template_id VARCHAR(100) NULL,
              is_active BOOLEAN DEFAULT TRUE,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )

    for event_name, template_text, template_id in SMS_TEMPLATE_SEEDS:
        db.execute(
            text(
                """
                INSERT INTO sms_templates (id, event_name, template_text, template_id, is_active)
                VALUES (UUID(), :event_name, :template_text, :template_id, TRUE)
                ON DUPLICATE KEY UPDATE
                  template_text = VALUES(template_text),
                  template_id = VALUES(template_id),
                  is_active = VALUES(is_active)
                """
            ),
            {"event_name": event_name, "template_text": template_text, "template_id": template_id},
        )



    db.commit()
    db.info["sms_tables_ready"] = True


def log_sms_attempt(
    *,
    recipient_mobile: str,
    message: str,
    sms_type: str | None,
    reference_id: str | None,
    status: str,
    error_message: str | None,
    db: Session,
) -> None:
    ensure_sms_tables(db)
    db.execute(
        text(
            """
            INSERT INTO notifications_log (
              recipient_mobile,
              message,
              type,
              reference_id,
              status,
              error_message,
              sent_at
            ) VALUES (
              :recipient_mobile,
              :message,
              :sms_type,
              :reference_id,
              :status,
              :error_message,
              CURRENT_TIMESTAMP
            )
            """
        ),
        {
            "recipient_mobile": recipient_mobile,
            "message": message,
            "sms_type": sms_type,
            "reference_id": reference_id,
            "status": status,
            "error_message": error_message,
        },
    )
    db.commit()


def format_mobile(mobile: str) -> str:
    digits = re.sub(r"\D", "", mobile or "")
    if len(digits) == 10:
        return f"91{digits}"
    if len(digits) == 12 and digits.startswith("91"):
        return digits
    raise ValueError("Invalid mobile number")


def send_sms(
    mobile: str,
    message: str,
    template_id: str | None,
    db: Session,
    event_name: str | None = None,
    reference_id: str | None = None,
    log_message: str | None = None,
) -> bool:
    """Send one SMS and log the attempt. log_message, if given, is what the log stores instead of the text sent."""
    sms_type = event_name or template_id
    log_text = message if log_message is None else log_message
    try:
        formatted_mobile = format_mobile(mobile)
    except ValueError:
        log_sms_attempt(
            recipient_mobile=mobile,
            message=log_text,
            sms_type=sms_type,
            reference_id=reference_id,
            status="failed",
            error_message="Invalid mobile number",
            db=db,
        )
        return False

    is_enabled = os.getenv("SMS_ENABLED", "true").lower() == "true"
    if not is_enabled:
        log_sms_attempt(
            recipient_mobile=formatted_mobile,
            message=log_text,
            sms_type=sms_type,
            reference_id=reference_id,
            status="skipped",
            error_message="SMS_ENABLED=false, not sent",
            db=db,
        )
        return True

    if not template_id:
        log_sms_attempt(
            recipient_mobile=formatted_mobile,
            message=log_text,
            sms_type=sms_type,
            reference_id=reference_id,
            status="failed",
            error_message="Missing DLT template ID",
            db=db,
        )
        return False

    if not SMS_API_KEY or not SMS_USERNAME:
        log_sms_attempt(
            recipient_mobile=formatted_mobile,
            message=log_text,
            sms_type=sms_type,
            reference_id=reference_id,
            status="failed",
            error_message="SMS_API_KEY / SMS_USERNAME not configured",
            db=db,
        )
        return False

    params = {
        "apikey": SMS_API_KEY,
        "user": SMS_USERNAME,
        "sender": SMS_SENDER,
        "number": formatted_mobile,
        "message": message,
        "coding": "1",
        "templateid": template_id,
    }
    if SMS_PEID.strip():
        params["peid"] = SMS_PEID.strip()

    try:
        response = httpx.get(SMS_BASE_URL, params=params, timeout=SMS_TIMEOUT_SECONDS)
        response_text = response.text.strip()
    except httpx.HTTPError as exc:
        log_sms_attempt(
            recipient_mobile=formatted_mobile,
            message=log_text,
            sms_type=sms_type,
            reference_id=reference_id,
            status="failed",
            error_message=str(exc),
            db=db,
        )
        return False

    if "MessageId-" in response_text:
        log_sms_attempt(
            recipient_mobile=formatted_mobile,
            message=log_text,
            sms_type=sms_type,
            reference_id=reference_id,
            status="sent",
            error_message=None,
            db=db,
        )
        return True

    log_sms_attempt(
        recipient_mobile=formatted_mobile,
        message=log_text,
        sms_type=sms_type,
        reference_id=reference_id,
        status="failed",
        error_message=response_text,
        db=db,
    )
    return False


def get_template(event_name: str, db: Session):
    ensure_sms_tables(db)
    return (
        db.query(SMSTemplate)
        .filter(SMSTemplate.event_name == event_name, SMSTemplate.is_active == True)
        .first()
    )


def render_template(template_text: str, variables: dict) -> str:
    def replacer(match: re.Match[str]) -> str:
        key = match.group(1)
        value = variables.get(key)
        return str(value) if value is not None else match.group(0)

    return re.sub(r"\{([a-zA-Z0-9_]+)\}", replacer, template_text)


def send_template_sms(
    mobile: str,
    event_name: str,
    variables: dict,
    db: Session,
    reference_id: str | None = None,
    secret_variables: tuple[str, ...] = (),
) -> bool:
    """Send the SMS for event_name; variables named in secret_variables (e.g. an OTP) are masked in the log."""
    template = get_template(event_name, db)
    if not template:
        logger.warning("SMS template missing or inactive for event '%s'", event_name)
        log_sms_attempt(
            recipient_mobile=mobile,
            message=f"Missing template for event {event_name}",
            sms_type=event_name,
            reference_id=reference_id,
            status="failed",
            error_message="Missing or inactive SMS template",
            db=db,
        )
        return False

    message = render_template(template.template_text, variables)
    masked = {**variables, **{name: "******" for name in secret_variables}}
    return send_sms(
        mobile=mobile,
        message=message,
        template_id=template.template_id,
        db=db,
        event_name=event_name,
        reference_id=reference_id,
        log_message=render_template(template.template_text, masked) if secret_variables else None,
    )
