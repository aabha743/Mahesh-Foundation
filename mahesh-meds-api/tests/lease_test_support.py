"""Shared setup for the lease request API tests (they need a *_test database, see conftest.py)."""
import secrets
import unittest
import uuid
from datetime import datetime, UTC

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.permissions import invalidate_permission_cache
from app.security import TRACK_COOKIE, create_access_token, create_track_token
from app.models import Asset, AuditLog, Center, LeaseItem, LeaseRequest, NotificationLog, Role, SKU, SKUBlock, User

CSRF = "test-csrf-token"
NO_HOLD = object()


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def random_mobile() -> str:
    return "7" + "".join(secrets.choice("0123456789") for _ in range(9))


class LeaseApiTestCase(unittest.TestCase):
    """Two centers, two device models, an approver and a center manager; everything is removed afterwards."""

    @classmethod
    def setUpClass(cls):
        cls.db = SessionLocal()
        suffix = uuid.uuid4().hex[:8].upper()
        cls.center = Center(name=f"Lease Test Center {suffix}", city="Test")
        cls.other_center = Center(name=f"Lease Test Other Center {suffix}", city="Test")
        cls.sku = SKU(name=f"Lease Test Device {suffix}", sku_code=f"LTEST-{suffix}")
        cls.other_sku = SKU(name=f"Lease Test Other Device {suffix}", sku_code=f"LTEST2-{suffix}")
        cls.db.add_all([cls.center, cls.other_center, cls.sku, cls.other_sku])
        cls.db.flush()
        roles = {role.name: role for role in cls.db.query(Role).all()}
        cls.approver = User(name="Lease Test Approver", mobile=random_mobile(), roles=[roles["approver"]])
        cls.center_manager = User(name="Lease Test Center Manager", mobile=random_mobile(), center_id=cls.center.id,
                                  roles=[roles["center_manager"]])
        cls.db.add_all([cls.approver, cls.center_manager])
        cls.db.commit()
        cls.lease_ids: list[str] = []
        cls.asset_ids: list[str] = []
        cls.assets = [cls.make_asset() for _ in range(3)]
        cls.client = TestClient(app)

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
        for asset_id in cls.asset_ids:
            db.query(AuditLog).filter(AuditLog.entity_id == asset_id).delete()
            db.query(Asset).filter(Asset.id == asset_id).delete()
        for user in (cls.approver, cls.center_manager):
            invalidate_permission_cache(user.id)
            db.query(AuditLog).filter(AuditLog.user_id == user.id).delete()
            user.roles = []
            db.flush()
            db.delete(user)
        db.flush()
        for row in (cls.sku, cls.other_sku, cls.center, cls.other_center):
            db.delete(row)
        db.commit()
        db.close()

    def setUp(self):
        # Start each test without an open transaction (see sms_count).
        self.db.rollback()

    @classmethod
    def make_asset(cls, sku: SKU | None = None, center: Center | None = None, status: str = "available") -> Asset:
        sku = sku or cls.sku
        center = center or cls.center
        asset = Asset(sku_id=sku.id, serial_number=f"LTEST-{uuid.uuid4().hex[:12].upper()}", center_id=center.id,
                      home_center_id=center.id, status=status)
        cls.db.add(asset)
        cls.db.commit()
        cls.asset_ids.append(asset.id)
        return asset

    def make_lease(self, status: str, lines: list, hold_release_at=NO_HOLD) -> LeaseRequest:
        """Create a request with one line per entry in `lines`.

        An entry is an asset id or None (a line for the default model), or a (sku, asset id or None) pair.
        `hold_release_at` adds one stock hold for the default model at the test center.
        """
        lease = LeaseRequest(
            token_number=f"LT-{uuid.uuid4().hex[:10].upper()}",
            requestor_name="Lease Test Requestor",
            mobile=random_mobile(),
            aadhar_number="999988887777",
            patient_name="Lease Test Patient",
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
        for entry in lines:
            sku, asset_id = entry if isinstance(entry, tuple) else (self.sku, entry)
            self.db.add(LeaseItem(
                lease_request_id=lease.id,
                sku_id=sku.id,
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

    def reload(self, row) -> None:
        # End this session's transaction first: MariaDB's REPEATABLE READ would otherwise keep
        # showing the snapshot taken before the API call or job committed.
        self.db.rollback()
        self.db.refresh(row)

    def holds(self, lease: LeaseRequest) -> list[SKUBlock]:
        self.reload(lease)
        return self.db.query(SKUBlock).filter(SKUBlock.lease_request_id == lease.id).all()

    def items(self, lease: LeaseRequest) -> list[LeaseItem]:
        self.reload(lease)
        return self.db.query(LeaseItem).filter(LeaseItem.lease_request_id == lease.id).all()

    def sms_count(self, lease: LeaseRequest, event_name: str) -> int:
        self.db.rollback()
        count = self.db.query(NotificationLog).filter(
            NotificationLog.reference_id == lease.id, NotificationLog.type == event_name
        ).count()
        # End the read transaction: sending an SMS runs ALTER TABLE notifications_log (app/services/sms.py),
        # which would wait for any open transaction that has read that table.
        self.db.rollback()
        return count

    def audit_count(self, lease: LeaseRequest, action: str) -> int:
        self.db.rollback()
        count = self.db.query(AuditLog).filter(AuditLog.entity_id == lease.id, AuditLog.action == action).count()
        self.db.rollback()
        return count

    def verified_client(self, mobile: str) -> TestClient:
        """A browser that verified `mobile` by OTP (has a tracking session), as the public status page does."""
        return TestClient(app, cookies={TRACK_COOKIE: create_track_token(mobile)})

    def patch_as(self, user: User, lease: LeaseRequest, body: dict):
        client = TestClient(app, cookies={"access_token": create_access_token(user.id), "csrf_token": CSRF})
        return client.patch(f"/api/v1/lease-requests/{lease.id}", json=body, headers={"X-CSRF-Token": CSRF})
