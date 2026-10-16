import secrets
import unittest
import uuid
from datetime import datetime, UTC, timedelta

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.jobs.reminders import release_expired_blocks
from app.main import EXPIRED_REQUEST_DETAIL, PICKUP_WINDOW_HOURS, app, create_access_token, invalidate_permission_cache
from app.models import Asset, AuditLog, Center, LeaseItem, LeaseRequest, NotificationLog, Role, SKU, SKUBlock, User

CSRF = "test-csrf-token"
NO_HOLD = object()


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def random_mobile() -> str:
    return "7" + "".join(secrets.choice("0123456789") for _ in range(9))


class LeaseExpiryTests(unittest.TestCase):
    """Pickup-window expiry: the background job, re-approval and the guards around expired requests."""

    @classmethod
    def setUpClass(cls):
        cls.db = SessionLocal()
        suffix = uuid.uuid4().hex[:8].upper()
        cls.center = Center(name=f"Expiry Test Center {suffix}", city="Test")
        cls.sku = SKU(name=f"Expiry Test Device {suffix}", sku_code=f"EXPTEST-{suffix}")
        cls.db.add_all([cls.center, cls.sku])
        cls.db.flush()
        cls.assets = [
            Asset(sku_id=cls.sku.id, serial_number=f"EXPTEST-{suffix}-{n}", center_id=cls.center.id,
                  home_center_id=cls.center.id, status="available")
            for n in range(3)
        ]
        cls.db.add_all(cls.assets)
        roles = {role.name: role for role in cls.db.query(Role).all()}
        cls.approver = User(name="Expiry Test Approver", mobile=random_mobile(), roles=[roles["approver"]])
        cls.center_manager = User(name="Expiry Test Center Manager", mobile=random_mobile(), center_id=cls.center.id,
                                  roles=[roles["center_manager"]])
        cls.db.add_all([cls.approver, cls.center_manager])
        cls.db.commit()
        cls.client = TestClient(app)
        cls.lease_ids: list[str] = []

    @classmethod
    def tearDownClass(cls):
        db = cls.db
        db.rollback()
        for lease_id in cls.lease_ids:
            db.query(NotificationLog).filter(NotificationLog.reference_id == lease_id).delete()
            db.query(SKUBlock).filter(SKUBlock.lease_request_id == lease_id).delete()
            db.query(LeaseItem).filter(LeaseItem.lease_request_id == lease_id).delete()
            db.query(AuditLog).filter(AuditLog.entity_id == lease_id).delete()
            db.query(LeaseRequest).filter(LeaseRequest.id == lease_id).delete()
        for user in (cls.approver, cls.center_manager):
            invalidate_permission_cache(user.id)
            db.query(AuditLog).filter(AuditLog.user_id == user.id).delete()
            user.roles = []
            db.flush()
            db.delete(user)
        for asset in cls.assets:
            db.delete(asset)
        db.flush()
        db.delete(cls.sku)
        db.delete(cls.center)
        db.commit()
        db.close()

    def setUp(self):
        self.db.expire_all()

    # --- helpers ---------------------------------------------------------

    def make_lease(self, status: str, lines: list[str | None], hold_release_at=NO_HOLD) -> LeaseRequest:
        """Create a request with one line per entry in `lines` (asset id or None) and optionally one stock hold."""
        lease = LeaseRequest(
            token_number=f"EXP-{uuid.uuid4().hex[:10].upper()}",
            requestor_name="Expiry Test Requestor",
            mobile=random_mobile(),
            aadhar_number="999988887777",
            patient_name="Expiry Test Patient",
            delivery_address="Test address",
            delivery_landmark="Test landmark",
            reference_name="Test referrer",
            preferred_center_id=self.center.id,
            expected_duration="1 Week",
            status=status,
        )
        self.db.add(lease)
        self.db.flush()
        self.lease_ids.append(lease.id)
        for asset_id in lines:
            self.db.add(LeaseItem(
                lease_request_id=lease.id,
                sku_id=self.sku.id,
                quantity_requested=1,
                asset_id=asset_id,
                issued_at=utcnow() if asset_id else None,
            ))
        if hold_release_at is not NO_HOLD:
            self.db.add(SKUBlock(
                lease_request_id=lease.id,
                sku_id=self.sku.id,
                center_id=self.center.id,
                status="blocked",
                release_at=hold_release_at,
            ))
        self.db.commit()
        return lease

    def reload(self, lease: LeaseRequest) -> None:
        # End this session's transaction first: MariaDB's REPEATABLE READ would otherwise keep
        # showing the snapshot taken before the API call or job committed.
        self.db.rollback()
        self.db.refresh(lease)

    def holds(self, lease: LeaseRequest) -> list[SKUBlock]:
        self.reload(lease)
        return self.db.query(SKUBlock).filter(SKUBlock.lease_request_id == lease.id).all()

    def patch_as(self, user: User, lease: LeaseRequest, body: dict):
        client = TestClient(app, cookies={"access_token": create_access_token(user.id), "csrf_token": CSRF})
        return client.patch(f"/api/v1/lease-requests/{lease.id}", json=body, headers={"X-CSRF-Token": CSRF})

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
        self.assertEqual(
            self.db.query(AuditLog).filter(AuditLog.entity_id == lease.id, AuditLog.action == "request_expired").count(), 0
        )

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
