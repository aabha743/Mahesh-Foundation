import unittest
from datetime import timedelta

import lease_test_support as support
from app.jobs.reminders import release_expired_blocks
from app.leasing import EXPIRED_REQUEST_DETAIL, PICKUP_WINDOW_HOURS
from app.models import AuditLog
from lease_test_support import utcnow


class LeaseExpiryTests(support.LeaseApiTestCase):
    """Pickup-window expiry: the background job, re-approval and the guards around expired requests."""

    # --- background job --------------------------------------------------

    def test_job_expires_uncollected_approved_request(self):
        lease = self.make_lease("approved", [None], hold_release_at=utcnow() - timedelta(minutes=1))

        release_expired_blocks()

        self.reload(lease)
        self.assertEqual(lease.status, "expired")
        [hold] = self.holds(lease)
        self.assertEqual((hold.status, hold.release_reason), ("released", "approved_timeout"))
        audit = self.db.query(AuditLog).filter(AuditLog.entity_id == lease.id, AuditLog.action == "request_expired").one()
        self.assertEqual(audit.new_value["token"], lease.token_number)

    def test_job_keeps_partly_issued_request_approved(self):
        lease = self.make_lease("approved", [self.assets[0].id, None], hold_release_at=utcnow() - timedelta(minutes=1))

        release_expired_blocks()

        self.reload(lease)
        self.assertEqual(lease.status, "approved")
        [hold] = self.holds(lease)
        self.assertEqual((hold.status, hold.release_reason), ("released", "approved_timeout"))
        self.assertEqual(self.audit_count(lease, "request_expired"), 0)

    def test_job_leaves_hold_inside_window_alone(self):
        lease = self.make_lease("approved", [None], hold_release_at=utcnow() + timedelta(hours=1))

        release_expired_blocks()

        self.reload(lease)
        self.assertEqual(lease.status, "approved")
        self.assertEqual(self.holds(lease)[0].status, "blocked")

    def test_job_never_expires_request_approved_without_stock_hold(self):
        lease = self.make_lease("approved", [None])

        release_expired_blocks()

        self.reload(lease)
        self.assertEqual(lease.status, "approved")

    # --- API -------------------------------------------------------------

    def test_reapproving_expired_request_reserves_stock_again(self):
        lease = self.make_lease("expired", [None])

        response = self.patch_as(self.approver, lease, {"status": "approved"})

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "approved")
        [hold] = self.holds(lease)
        self.assertEqual(hold.status, "blocked")
        expected_deadline = utcnow() + timedelta(hours=PICKUP_WINDOW_HOURS)
        self.assertLess(abs((hold.release_at - expected_deadline).total_seconds()), 120)

    def test_rejecting_expired_request_is_allowed(self):
        lease = self.make_lease("expired", [None])

        response = self.patch_as(self.approver, lease, {"status": "rejected", "rejection_reason": "Patient no longer needs it"})

        self.assertEqual(response.status_code, 200, response.text)
        self.reload(lease)
        self.assertEqual(lease.status, "rejected")

    def test_issuing_against_expired_request_is_refused(self):
        lease = self.make_lease("expired", [None])
        body = {"status": "active", "items": [{"sku_id": self.sku.id, "quantity_requested": 1, "asset_id": self.assets[1].id}]}

        response = self.patch_as(self.center_manager, lease, body)

        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(response.json()["detail"], EXPIRED_REQUEST_DETAIL)
        self.reload(lease)
        self.assertEqual(lease.status, "expired")

    def test_clients_cannot_mark_a_request_expired(self):
        lease = self.make_lease("approved", [None])

        response = self.patch_as(self.approver, lease, {"status": "expired"})

        self.assertEqual(response.status_code, 400, response.text)
        self.reload(lease)
        self.assertEqual(lease.status, "approved")

    def test_public_lookup_of_expired_request_has_no_pickup_guidance(self):
        lease = self.make_lease("expired", [None])

        response = self.client.get(f"/api/v1/lease-requests/by-token/{lease.token_number}")

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["status"], "expired")
        self.assertEqual(payload["fulfillment_centers"], [])
        self.assertIsNone(payload["fulfillment_message"])


if __name__ == "__main__":
    unittest.main()
