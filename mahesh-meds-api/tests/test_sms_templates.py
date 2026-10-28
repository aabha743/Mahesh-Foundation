import os
import re
import unittest
from datetime import date, timedelta
from unittest.mock import patch

from fastapi.testclient import TestClient

import lease_test_support as support
from app.main import app
from app.jobs.reminders import release_expired_blocks
from app.models import LeaseExtension, LeaseItem, NotificationLog
from app.notifications import DLT_VARIABLE_MAX, FOUNDATION_CONTACT_MOBILE, fit, site_url, sms_date, template_on
from app.security import create_access_token
from app.services.sms import SMS_TEMPLATE_SEEDS

# Exactly as registered on the DLT portal in October 2026 (copied from the registrations, double spaces included).
REGISTERED = {
    "mf_request_received": ("1277179258580359181",
        "Mahesh Foundation: Your medical equipment request is received. Token:{#alphanumeric#} . Track it at {#url#}   - MHSFND"),
    "mf_request_approved": ("1277179265177418932",  # MF_Request_Approved_num (22 Oct)
        "Mahesh Foundation: Request {#alphanumeric#} approved. Collect from {#alphanumeric#}  within 3 days. Contact {#alphanumeric#} {#cbn#}  . Track your request on: {#url#} - MHSFND"),
    "mf_request_rejected": ("1277179265313329507",
        "Mahesh Foundation: Request {#alphanumeric#} could not be approved. For any questions, please call {#cbn#} . - MHSFND"),
    "mf_extension_not_approved": ("1277179265283139892",
        "Mahesh Foundation: Your extension request for Token {#alphanumeric#} could not be approved. Please return the devices by {#alphanumeric#} or call {#cbn#} . - MHSFND"),
    "mf_token_expired": ("1277179265582573786",
        "Mahesh Foundation: Your request of token: {#alphanumeric#} has expired as it was not collected within 3 days. Please re-apply at {#url#} and get a new token. - MHSFND"),
    "mf_tracking_otp": ("1277179258196035097",
        "Your OTP is {#number#}  to view your Mahesh Foundation medical equipment request. Valid for 5 minutes. Please do not share it with anyone. - MHSFND"),
    "mf_referrer_notice": ("1277179258745423631",
        "Mahesh Foundation: This is to inform you that {#alphanumeric#}  has listed you as a referrer for medical equipment request {#alphanumeric#}. - MHSFND"),
    "mf_extension_received": ("1277179258409353603",
        "Mahesh Foundation: Your extension request for Token: {#alphanumeric#} has been received and is under consideration . - MHSFND"),
    "mf_extension_approved": ("1277179258261227432",
        "Mahesh Foundation: Your extension request for Token {#alphanumeric#} is approved. New return date: {#alphanumeric#} . - MHSFND"),
}
# Awaiting DLT approval on 23 Oct 2026: the value set on the server until they are approved.
AWAITING_APPROVAL = "mf_request_approved,mf_request_rejected,mf_extension_not_approved,mf_token_expired"
VARIABLE_TYPES = {  # every other variable is {#alphanumeric#}
    "otp": "{#number#}",
    "site_url": "{#url#}",  # only the bare site address is whitelisted on DLT
    "contact_mobile": "{#cbn#}",  # a whitelisted call-back number
}


class RegisteredTextTests(unittest.TestCase):
    """A message that differs from its DLT registration by one character is rejected by the operator."""

    def test_each_new_template_matches_its_registration(self):
        seeds = {event: (text, template_id) for event, text, template_id in SMS_TEMPLATE_SEEDS}
        for event, (template_id, registered) in REGISTERED.items():
            with self.subTest(event):
                text, seeded_id = seeds[event]
                as_registered = re.sub(r"\{([a-z_]+)\}", lambda m: VARIABLE_TYPES.get(m.group(1), "{#alphanumeric#}"), text)
                self.assertEqual(as_registered, registered)
                self.assertEqual(seeded_id, template_id)

    def test_values_fit_the_portals_variable_limit(self):
        self.assertEqual(len(fit("A" * 60)), DLT_VARIABLE_MAX)
        self.assertEqual(fit("  Hyderabad  "), "Hyderabad")
        self.assertEqual(sms_date(date(2026, 10, 30)), "30 Oct 2026")
        self.assertEqual(site_url(), "https://maheshfoundation-medical.com")
        with patch.dict(os.environ, {"PUBLIC_SITE_URL": "https://maheshfoundation-medical.com/ "}):
            self.assertEqual(site_url(), "https://maheshfoundation-medical.com")

    def test_templates_can_be_switched_off_one_by_one(self):
        with patch.dict(os.environ, {"SMS_TEMPLATES_OFF": " MF_Request_Approved , mf_token_expired,"}):
            self.assertFalse(template_on("mf_request_approved"))
            self.assertFalse(template_on("mf_token_expired"))
            self.assertTrue(template_on("mf_request_received"))
        with patch.dict(os.environ, {"SMS_TEMPLATES_OFF": "", "SMS_NEW_TEMPLATES": "false"}):
            self.assertFalse(template_on("mf_request_received"))
        with patch.dict(os.environ, {"SMS_TEMPLATES_OFF": ""}):
            self.assertTrue(all(template_on(event) for event in REGISTERED))


class NewSmsTests(support.LeaseApiTestCase):
    """Which SMS go out, to whom and with what, on the new templates (and on the earlier ones when switched off)."""

    def sms(self, lease, event) -> list[dict]:
        """The SMS logged for a request, as plain values: reading a row object again later would open a
        transaction on notifications_log, which blocks the table check every SMS send runs (app/services/sms.py)."""
        self.db.rollback()
        rows = [
            {"recipient_mobile": row.recipient_mobile, "message": row.message}
            for row in self.db.query(NotificationLog).filter(
                NotificationLog.reference_id == lease.id, NotificationLog.type == event
            )
        ]
        self.db.rollback()
        return rows

    def submit(self, **overrides):
        self.make_asset()
        body = {
            "requestor_name": "Sms Test Requestor", "mobile": support.random_mobile(), "aadhar_number": "999988887777",
            "patient_name": "Sms Test Patient", "delivery_address": "1 Test Street", "reference_name": "Dr Sms",
            "expected_duration": "1 Week",
            "items": [{"sku_id": self.sku.id, "quantity_requested": 1, "pickup_center_id": self.center.id}],
            **support.FORM_FIELDS, **overrides,
        }
        response = self.client.post("/api/v1/lease-requests", json=body)
        self.assertEqual(response.status_code, 200, response.text)
        self.lease_ids.append(response.json()["id"])
        self.db.rollback()
        from app.models import LeaseRequest
        return self.db.get(LeaseRequest, response.json()["id"])

    # --- on submission ---------------------------------------------------------------------------------

    def test_requester_gets_the_link_and_the_referrer_is_told(self):
        lease = self.submit(reference_mobile="9876500022")

        [received] = self.sms(lease, "mf_request_received")
        [referrer] = self.sms(lease, "mf_referrer_notice")
        self.assertTrue(received["recipient_mobile"].endswith(lease.mobile))
        self.assertIn(f"Token:{lease.token_number} . Track it at {site_url()}   - MHSFND", received["message"])
        self.assertNotIn("/track/", received["message"])  # any other link is not delivered
        self.assertTrue(referrer["recipient_mobile"].endswith("9876500022"))
        self.assertIn("This is to inform you that Sms Test Requestor  has listed you", referrer["message"])
        self.assertEqual(self.sms(lease, "request_submitted_user"), [])

    def test_no_referrer_notice_when_the_requester_refers_themselves(self):
        mobile = support.random_mobile()
        lease = self.submit(mobile=mobile, reference_mobile=mobile)

        self.assertEqual(self.sms(lease, "mf_referrer_notice"), [])
        self.assertEqual(len(self.sms(lease, "mf_request_received")), 1)

    def test_switched_off_everything_goes_out_on_the_earlier_templates(self):
        with patch.dict(os.environ, {"SMS_NEW_TEMPLATES": "false"}):
            lease = self.submit()

        self.assertEqual(len(self.sms(lease, "request_submitted_user")), 1)
        self.assertEqual(self.sms(lease, "mf_request_received") + self.sms(lease, "mf_referrer_notice"), [])

    # --- on approval -----------------------------------------------------------------------------------

    def pending_at(self, center):
        self.make_asset(center=center)
        lease = self.make_lease("pending", [None])
        self.db.query(LeaseItem).filter(LeaseItem.lease_request_id == lease.id).update({"pickup_center_id": center.id})
        self.db.commit()
        return lease

    def test_approval_names_the_pickup_centers_manager(self):
        lease = self.pending_at(self.center)

        response = self.patch_as(self.approver, lease, {"status": "approved"})

        self.assertEqual(response.status_code, 200, response.text)
        [approved] = self.sms(lease, "mf_request_approved")
        self.assertIn(f"Collect from {self.center.name}  within 3 days. Contact {self.center_manager.name} "
                      f"{self.center_manager.mobile}  . Track your request on: {site_url()} - MHSFND",
                      approved["message"])
        self.assertNotIn("/track/", approved["message"])
        self.assertEqual(self.sms(lease, "request_approved_user"), [])
        self.assertEqual(len(self.sms(lease, "request_approved_center_manager")), 1)

    def test_a_center_without_a_manager_gets_the_earlier_approval_sms(self):
        lease = self.pending_at(self.other_center)  # no center manager there

        self.patch_as(self.approver, lease, {"status": "approved"})

        self.assertEqual(self.sms(lease, "mf_request_approved"), [])
        self.assertEqual(len(self.sms(lease, "request_approved_user")), 1)

    def test_approval_uses_the_earlier_sms_while_its_template_is_off(self):
        lease = self.pending_at(self.center)

        with patch.dict(os.environ, {"SMS_TEMPLATES_OFF": AWAITING_APPROVAL}):
            self.patch_as(self.approver, lease, {"status": "approved"})

        self.assertEqual(self.sms(lease, "mf_request_approved"), [])
        self.assertEqual(len(self.sms(lease, "request_approved_user")), 1)

    # --- rejection and expiry ------------------------------------------------------------------------------

    def test_rejection_gives_the_foundations_number(self):
        lease = self.make_lease("pending", [None])  # pickup at the test center, which has a manager

        self.patch_as(self.approver, lease, {"status": "rejected"})

        [rejected] = self.sms(lease, "mf_request_rejected")
        self.assertEqual(FOUNDATION_CONTACT_MOBILE, "9849001740")
        self.assertIn(f"Request {lease.token_number} could not be approved. For any questions, please call "
                      f"9849001740 . - MHSFND", rejected["message"])
        self.assertNotIn(self.center_manager.mobile, rejected["message"])
        self.assertEqual(self.sms(lease, "request_rejected_user"), [])

    def test_rejection_at_a_center_without_a_manager_also_gives_the_foundations_number(self):
        lease = self.make_lease("pending", [None])
        lease.preferred_center_id = self.other_center.id  # no center manager there
        self.db.commit()

        self.patch_as(self.approver, lease, {"status": "rejected"})

        [rejected] = self.sms(lease, "mf_request_rejected")
        self.assertIn("please call 9849001740 . - MHSFND", rejected["message"])
        self.assertEqual(self.sms(lease, "request_rejected_user"), [])

    def test_rejection_uses_the_earlier_sms_while_its_template_is_off(self):
        lease = self.make_lease("pending", [None])  # the test center has a manager

        with patch.dict(os.environ, {"SMS_TEMPLATES_OFF": AWAITING_APPROVAL}):
            self.patch_as(self.approver, lease, {"status": "rejected"})

        self.assertEqual(len(self.sms(lease, "request_rejected_user")), 1)
        self.assertEqual(self.sms(lease, "mf_request_rejected"), [])

    def test_no_expiry_sms_while_its_template_is_off(self):
        lease = self.make_lease("approved", [None], hold_release_at=support.utcnow() - timedelta(hours=1))

        with patch.dict(os.environ, {"SMS_TEMPLATES_OFF": AWAITING_APPROVAL}):
            release_expired_blocks()

        self.reload(lease)
        self.assertEqual(lease.status, "expired")
        self.assertEqual(self.sms(lease, "mf_token_expired"), [])

    def test_an_expired_request_is_told_to_apply_again(self):
        lease = self.make_lease("approved", [None], hold_release_at=support.utcnow() - timedelta(hours=1))

        release_expired_blocks()

        self.reload(lease)
        self.assertEqual(lease.status, "expired")
        [expired] = self.sms(lease, "mf_token_expired")
        self.assertIn(f"Your request of token: {lease.token_number} has expired as it was not collected within 3 days. "
                      f"Please re-apply at {site_url()} and get a new token. - MHSFND", expired["message"])

    # --- extensions ------------------------------------------------------------------------------------

    def issued_and_due(self):
        lease = self.make_lease("issued", [self.make_asset(status="leased").id])
        lines = self.items(lease)
        lease.due_date = date.today() + timedelta(days=3)
        for line in lines:
            line.due_date = lease.due_date
        self.db.commit()
        return lease

    def test_extension_received_and_approved(self):
        lease = self.issued_and_due()
        asked = self.verified_client(lease.mobile).post("/api/v1/lease-extensions", json={
            "token_number": lease.token_number,
            "requested_due_date": (date.today() + timedelta(days=8)).isoformat(),
            "reason": "Patient still recovering",
        })
        self.assertEqual(asked.status_code, 200, asked.text)
        [received] = self.sms(lease, "mf_extension_received")
        self.assertIn(f"for Token: {lease.token_number} has been received and is under consideration . - MHSFND", received["message"])

        approver = TestClient(app, cookies={"access_token": create_access_token(self.approver.id), "csrf_token": support.CSRF})
        decided = approver.patch(f"/api/v1/lease-extensions/{asked.json()['id']}", json={"status": "approved"},
                                 headers={"X-CSRF-Token": support.CSRF})

        self.assertEqual(decided.status_code, 200, decided.text)
        [approved] = self.sms(lease, "mf_extension_approved")
        new_date = (date.today() + timedelta(days=8)).strftime("%d %b %Y")
        self.assertIn(f"for Token {lease.token_number} is approved. New return date: {new_date} . - MHSFND", approved["message"])
        self.db.rollback()
        self.assertEqual(self.db.get(LeaseExtension, asked.json()["id"]).status, "approved")

    def test_extension_not_approved_gives_the_return_date_and_a_number(self):
        lease = self.issued_and_due()
        asked = self.verified_client(lease.mobile).post("/api/v1/lease-extensions", json={
            "token_number": lease.token_number,
            "requested_due_date": (date.today() + timedelta(days=8)).isoformat(),
            "reason": "Patient still recovering",
        })
        approver = TestClient(app, cookies={"access_token": create_access_token(self.approver.id), "csrf_token": support.CSRF})

        decided = approver.patch(f"/api/v1/lease-extensions/{asked.json()['id']}", json={"status": "rejected"},
                                 headers={"X-CSRF-Token": support.CSRF})

        self.assertEqual(decided.status_code, 200, decided.text)
        [refused] = self.sms(lease, "mf_extension_not_approved")
        due = (date.today() + timedelta(days=3)).strftime("%d %b %Y")
        self.assertIn(f"for Token {lease.token_number} could not be approved. Please return the devices by {due} "
                      f"or call 9849001740 . - MHSFND", refused["message"])
        self.assertNotIn(self.center_manager.mobile, refused["message"])

    def test_no_extension_refusal_sms_while_its_template_is_off(self):
        lease = self.issued_and_due()
        with patch.dict(os.environ, {"SMS_TEMPLATES_OFF": AWAITING_APPROVAL}):
            asked = self.verified_client(lease.mobile).post("/api/v1/lease-extensions", json={
                "token_number": lease.token_number,
                "requested_due_date": (date.today() + timedelta(days=8)).isoformat(),
                "reason": "Patient still recovering",
            })
            approver = TestClient(app, cookies={"access_token": create_access_token(self.approver.id), "csrf_token": support.CSRF})
            decided = approver.patch(f"/api/v1/lease-extensions/{asked.json()['id']}", json={"status": "rejected"},
                                     headers={"X-CSRF-Token": support.CSRF})

        self.assertEqual(decided.status_code, 200, decided.text)
        self.assertEqual(self.sms(lease, "mf_extension_not_approved"), [])
        self.assertEqual(len(self.sms(lease, "mf_extension_received")), 1)  # approved on DLT, so still sent

    # --- OTP codes -------------------------------------------------------------------------------------

    def test_staff_login_keeps_its_template_and_tracking_uses_the_new_one(self):
        with patch("app.otp.generate_otp", return_value="777111"):
            self.client.post("/auth/request-otp", json={"mobile": self.center_manager.mobile})
            lease = self.issued_and_due()
            self.client.post("/api/v1/track/send-otp", json={"query": lease.token_number})
        self.db.rollback()
        otp_types = NotificationLog.type.in_(("otp_login", "mf_tracking_otp"))
        staff = self.db.query(NotificationLog).filter(otp_types, NotificationLog.recipient_mobile.like(f"%{self.center_manager.mobile}")).all()
        track = self.db.query(NotificationLog).filter(otp_types, NotificationLog.recipient_mobile.like(f"%{lease.mobile}")).all()
        self.assertEqual([row.type for row in staff], ["otp_login"])
        self.assertEqual([row.type for row in track], ["mf_tracking_otp"])
        self.assertIn("Your OTP is ******  to view your", track[0].message)  # the code is masked in the log
        for row in staff + track:
            self.db.delete(row)
        self.db.commit()
