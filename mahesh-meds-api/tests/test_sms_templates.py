import os
import re
import unittest
from datetime import date, timedelta
from unittest.mock import patch

from fastapi.testclient import TestClient

import lease_test_support as support
from app.main import app
from app.models import LeaseExtension, LeaseItem, NotificationLog
from app.notifications import DLT_VARIABLE_MAX, fit, sms_date, track_url
from app.security import create_access_token
from app.services.sms import SMS_TEMPLATE_SEEDS

# Exactly as registered on the DLT portal in October 2026 (copied from the registrations, double spaces included).
REGISTERED = {
    "mf_request_received": ("1277179258580359181",
        "Mahesh Foundation: Your medical equipment request is received. Token:{#alphanumeric#} . Track it at {#url#}   - MHSFND"),
    "mf_request_approved": ("1277179258166424927",
        "Mahesh Foundation: Request {#alphanumeric#} approved. Collect from {#alphanumeric#}  within 3 days. Contact {#alphanumeric#} {#alphanumeric#}  . Details: {#url#} - MHSFND"),
    "mf_tracking_otp": ("1277179258196035097",
        "Your OTP is {#number#}  to view your Mahesh Foundation medical equipment request. Valid for 5 minutes. Please do not share it with anyone. - MHSFND"),
    "mf_referrer_notice": ("1277179258745423631",
        "Mahesh Foundation: This is to inform you that {#alphanumeric#}  has listed you as a referrer for medical equipment request {#alphanumeric#}. - MHSFND"),
    "mf_extension_received": ("1277179258409353603",
        "Mahesh Foundation: Your extension request for Token: {#alphanumeric#} has been received and is under consideration . - MHSFND"),
    "mf_extension_approved": ("1277179258261227432",
        "Mahesh Foundation: Your extension request for Token {#alphanumeric#} is approved. New return date: {#alphanumeric#} . - MHSFND"),
}
VARIABLE_TYPES = {"otp": "{#number#}", "track_url": "{#url#}"}  # every other variable is {#alphanumeric#}


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
        self.assertEqual(track_url("MF-OCT-0001"), "https://maheshfoundation-medical.com/track/MF-OCT-0001")


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
        self.assertIn(f"Token:{lease.token_number} . Track it at {track_url(lease.token_number)}   - MHSFND", received["message"])
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

    def test_approval_names_the_pickup_centers_manager_when_switched_on(self):
        lease = self.pending_at(self.center)

        with patch.dict(os.environ, {"SMS_APPROVED_WITH_CONTACT": "true"}):
            response = self.patch_as(self.approver, lease, {"status": "approved"})

        self.assertEqual(response.status_code, 200, response.text)
        [approved] = self.sms(lease, "mf_request_approved")
        self.assertIn(f"Collect from {self.center.name}  within 3 days. Contact {self.center_manager.name} "
                      f"{self.center_manager.mobile}  . Details: {track_url(lease.token_number)} - MHSFND", approved["message"])
        self.assertEqual(self.sms(lease, "request_approved_user"), [])
        self.assertEqual(len(self.sms(lease, "request_approved_center_manager")), 1)

    def test_a_center_without_a_manager_gets_the_earlier_approval_sms(self):
        lease = self.pending_at(self.other_center)  # no center manager there

        with patch.dict(os.environ, {"SMS_APPROVED_WITH_CONTACT": "true"}):
            self.patch_as(self.approver, lease, {"status": "approved"})

        self.assertEqual(self.sms(lease, "mf_request_approved"), [])
        self.assertEqual(len(self.sms(lease, "request_approved_user")), 1)

    def test_approval_sms_with_contact_is_off_by_default(self):
        lease = self.pending_at(self.center)

        self.patch_as(self.approver, lease, {"status": "approved"})

        self.assertEqual(self.sms(lease, "mf_request_approved"), [])
        self.assertEqual(len(self.sms(lease, "request_approved_user")), 1)

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
