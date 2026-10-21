import unittest
import uuid
from datetime import date, datetime, timedelta

from fastapi.testclient import TestClient

import lease_test_support as support
from app.leasing import compute_due_date
from app.main import app
from app.models import LeaseExtension, LeaseRequest, NotificationLog
from app.security import create_access_token


class RequestFormAndRejectionTests(support.LeaseApiTestCase):
    """Client feedback, phase 1: optional landmark, 1-4 week durations, rejections without a reason."""

    def submit(self, **overrides):
        self.make_asset()  # a submission holds one free device at its pickup center
        body = {
            "token_number": f"LT-{uuid.uuid4().hex[:10].upper()}",
            "requestor_name": "Form Test Requestor",
            "mobile": support.random_mobile(),
            "aadhar_number": "999988887777",
            "patient_name": "Form Test Patient",
            "delivery_address": "1 Test Street",
            "delivery_landmark": "Near the park",
            "reference_name": "Dr Test",
            "preferred_center_id": self.center.id,
            "expected_duration": "1 Week",
            "items": [{"sku_id": self.sku.id, "quantity_requested": 1}],
            **support.FORM_FIELDS,
            **overrides,
        }
        response = self.client.post("/api/v1/lease-requests", json=body)
        if response.status_code == 200:
            self.lease_ids.append(response.json()["id"])
        return response

    def staff_client(self, user=None) -> TestClient:
        user = user or self.approver
        return TestClient(app, cookies={"access_token": create_access_token(user.id), "csrf_token": support.CSRF})

    # --- request form ----------------------------------------------------------

    def test_landmark_is_optional(self):
        for landmark in (None, "   "):
            with self.subTest(landmark=landmark):
                response = self.submit(delivery_landmark=landmark)

                self.assertEqual(response.status_code, 200, response.text)
                self.db.rollback()  # see rows the API committed (REPEATABLE READ)
                lease = self.db.get(LeaseRequest, response.json()["id"])
                self.assertIsNone(lease.delivery_landmark)

    def test_landmark_field_can_be_left_out(self):
        body = {
            "token_number": f"LT-{uuid.uuid4().hex[:10].upper()}",
            "requestor_name": "Form Test Requestor",
            "mobile": support.random_mobile(),
            "aadhar_number": "999988887777",
            "patient_name": "Form Test Patient",
            "delivery_address": "1 Test Street",
            "reference_name": "Dr Test",
            "preferred_center_id": self.center.id,
            "expected_duration": "2 Weeks",
            "items": [{"sku_id": self.sku.id, "quantity_requested": 1}],
            **support.FORM_FIELDS,
        }

        self.make_asset()  # a submission holds one free device at its pickup center
        response = self.client.post("/api/v1/lease-requests", json=body)

        self.assertEqual(response.status_code, 200, response.text)
        self.lease_ids.append(response.json()["id"])

    def test_durations_from_one_to_four_weeks(self):
        for duration in ("1 Week", "2 Weeks", "3 Weeks", "4 Weeks"):
            with self.subTest(duration=duration):
                self.assertEqual(self.submit(expected_duration=duration).status_code, 200)
        for duration in ("5 Weeks", "1 Month", ""):
            with self.subTest(duration=duration):
                response = self.submit(expected_duration=duration)
                self.assertEqual(response.status_code, 400, response.text)
                self.assertIn("4 weeks", response.json()["detail"])

    def test_due_date_for_four_weeks(self):
        issued = datetime(2026, 10, 1, 9, 0)

        self.assertEqual(compute_due_date("4 Weeks", issued), date(2026, 10, 29))
        self.assertEqual(compute_due_date("3 Weeks", issued), date(2026, 10, 22))

    # --- what a public submission cannot set ------------------------------------

    def test_submitted_status_and_review_fields_are_ignored(self):
        for status in ("approved", "rejected", "active", "closed"):
            with self.subTest(status=status):
                response = self.submit(status=status, approval_comments="self-approved", rejection_reason="n/a")

                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["status"], "pending")
                self.db.rollback()
                lease = self.db.get(LeaseRequest, response.json()["id"])
                self.assertEqual((lease.status, lease.approval_comments, lease.rejection_reason), ("pending", None, None))
                self.assertEqual(self.sms_count(lease, "request_approved_user"), 0)
                self.assertEqual(self.audit_count(lease, "approve_request"), 0)

    def test_device_assignment_in_a_submission_is_ignored(self):
        device = self.make_asset()

        response = self.submit(status="active", items=[{"sku_id": self.sku.id, "quantity_requested": 1, "asset_id": device.id}])

        self.assertEqual(response.status_code, 200, response.text)
        self.db.rollback()
        lease = self.db.get(LeaseRequest, response.json()["id"])
        self.assertEqual(lease.status, "pending")
        self.assertEqual([line.asset_id for line in self.items(lease)], [None])
        self.reload(device)
        self.assertEqual(device.status, "available")
        self.assertEqual(self.sms_count(lease, "device_issued_user"), 0)

    # --- rejecting a request ---------------------------------------------------

    def test_reject_without_reason_sends_generic_contact(self):
        lease = self.make_lease("pending", [None])

        response = self.patch_as(self.approver, lease, {"status": "rejected"})

        self.assertEqual(response.status_code, 200, response.text)
        self.reload(lease)
        self.assertEqual(lease.status, "rejected")
        self.assertIsNone(lease.rejection_reason)
        sms = self.db.query(NotificationLog).filter(
            NotificationLog.reference_id == lease.id, NotificationLog.type == "request_rejected_user"
        ).one()
        self.assertIn("Mahesh Foundation team", sms.message)

    def test_reason_sent_by_an_old_screen_is_not_put_in_the_sms(self):
        lease = self.make_lease("pending", [None])

        response = self.patch_as(self.approver, lease, {"status": "rejected", "rejection_reason": "Stock is reserved for ICU patients"})

        self.assertEqual(response.status_code, 200, response.text)
        self.db.rollback()
        sms = self.db.query(NotificationLog).filter(
            NotificationLog.reference_id == lease.id, NotificationLog.type == "request_rejected_user"
        ).one()
        self.assertNotIn("ICU", sms.message)

    def test_public_lookup_hides_rejection_reasons_but_staff_see_them(self):
        lease = self.make_lease("rejected", [None])
        lease.rejection_reason = "Duplicate request"
        self.db.commit()
        url = f"/api/v1/lease-requests/by-token/{lease.token_number}"

        public = self.verified_client(lease.mobile).get(url).json()
        staff = self.staff_client().get(url).json()

        self.assertIsNone(public["rejection_reason"])
        self.assertEqual(staff["rejection_reason"], "Duplicate request")

    def test_mobile_lookup_hides_rejection_reasons(self):
        lease = self.make_lease("rejected", [None])
        lease.rejection_reason = "Duplicate request"
        self.db.commit()

        rows = self.verified_client(lease.mobile).get(f"/api/v1/lease-requests/by-mobile/{lease.mobile}").json()

        self.assertEqual([row["rejection_reason"] for row in rows], [None])

    # --- rejecting an extension ------------------------------------------------

    def make_extension(self) -> LeaseExtension:
        lease = self.make_lease("issued", [self.make_asset(status="leased").id])
        extension = LeaseExtension(
            lease_request_id=lease.id,
            token_number=lease.token_number,
            requested_duration="1 week",
            requested_days=7,
            reason="Still recovering",
            requestor_name=lease.requestor_name,
            mobile=lease.mobile,
            aadhar_number=lease.aadhar_number,
            current_due_date=date.today() + timedelta(days=2),
        )
        self.db.add(extension)
        self.db.commit()
        self.addCleanup(self.delete_extension, extension.id)
        return extension

    def delete_extension(self, extension_id: str) -> None:
        self.db.rollback()
        self.db.query(LeaseExtension).filter(LeaseExtension.id == extension_id).delete()
        self.db.commit()

    def test_extension_rejected_without_reason(self):
        extension = self.make_extension()

        response = self.staff_client().patch(
            f"/api/v1/lease-extensions/{extension.id}", json={"status": "rejected"},
            headers={"X-CSRF-Token": support.CSRF},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.reload(extension)
        self.assertEqual((extension.status, extension.rejection_reason), ("rejected", None))

    def test_extension_rejection_reason_is_hidden_from_the_public(self):
        extension = self.make_extension()
        self.staff_client().patch(
            f"/api/v1/lease-extensions/{extension.id}",
            json={"status": "rejected", "rejection_reason": "Device needed for another patient"},
            headers={"X-CSRF-Token": support.CSRF},
        )

        public = self.verified_client(extension.mobile).get(f"/api/v1/lease-requests/by-token/{extension.token_number}").json()

        self.assertEqual([entry["rejection_reason"] for entry in public["extension_history"]], [None])


if __name__ == "__main__":
    unittest.main()
