from datetime import UTC, datetime, timedelta
from unittest.mock import patch

from fastapi.testclient import TestClient

import lease_test_support as support
from app.main import app
from app.models import AuditLog, LeaseHandoverVerification, NotificationLog, OTPSession, Role, User
from app.permissions import invalidate_permission_cache
from app.routers.handover import MAX_HANDOVER_OTPS_PER_REQUEST_PER_DAY
from app.security import create_access_token

CODE = "535353"


def line(sku_id: str, asset_id: str | None = None) -> dict:
    return {"sku_id": sku_id, "quantity_requested": 1, "asset_id": asset_id}


class HandoverOtpTests(support.LeaseApiTestCase):
    """Phase 3: devices are issued only after the person collecting them reads out an OTP sent to the request's mobile."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        roles = {role.name: role for role in cls.db.query(Role).all()}
        # A second manager at the same center, and one at the other center.
        cls.colleague = User(name="Handover Test Colleague", mobile=support.random_mobile(), center_id=cls.center.id,
                             roles=[roles["center_manager"]])
        cls.other_manager = User(name="Handover Test Other Manager", mobile=support.random_mobile(),
                                 center_id=cls.other_center.id, roles=[roles["center_manager"]])
        cls.db.add_all([cls.colleague, cls.other_manager])
        cls.db.commit()

    @classmethod
    def tearDownClass(cls):
        db = cls.db
        db.rollback()
        for user in (cls.colleague, cls.other_manager):
            invalidate_permission_cache(user.id)
            db.query(AuditLog).filter(AuditLog.user_id == user.id).delete()
            db.query(LeaseHandoverVerification).filter(LeaseHandoverVerification.verified_by == user.id).delete()
            user.roles = []
            db.flush()
            db.delete(user)
        db.commit()
        super().tearDownClass()

    def setUp(self):
        super().setUp()
        self.mobiles: list[str] = []
        patcher = patch("app.otp.generate_otp", return_value=CODE)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.cleanup_sms_log)

    def cleanup_sms_log(self):
        self.db.rollback()
        if self.mobiles:
            self.db.query(NotificationLog).filter(
                NotificationLog.recipient_mobile.in_([f"91{m}" for m in self.mobiles] + self.mobiles)
            ).delete(synchronize_session=False)
        self.db.commit()

    def lease(self, status="approved", lines=None, mobile=None):
        lease = self.make_lease(status, [None] if lines is None else lines)
        if mobile:
            lease.mobile = mobile
            self.db.commit()
        self.mobiles.append(lease.mobile)
        return lease

    def staff(self, user: User) -> TestClient:
        return TestClient(app, cookies={"access_token": create_access_token(user.id), "csrf_token": support.CSRF},
                          headers={"X-CSRF-Token": support.CSRF})

    def send(self, lease, user=None, center=None):
        return self.staff(user or self.center_manager).post(
            f"/api/v1/lease-requests/{lease.id}/handover/send-otp", json={"center_id": (center or self.center).id}
        )

    def verify(self, lease, otp=CODE, user=None, center=None):
        return self.staff(user or self.center_manager).post(
            f"/api/v1/lease-requests/{lease.id}/handover/verify-otp",
            json={"center_id": (center or self.center).id, "otp": otp},
        )

    def issue(self, lease, lines, status="approved", user=None):
        return self.patch_as(user or self.center_manager, lease, {"status": status, "items": lines})

    def verifications(self, lease) -> list[LeaseHandoverVerification]:
        self.db.rollback()
        rows = self.db.query(LeaseHandoverVerification).filter(LeaseHandoverVerification.lease_request_id == lease.id).all()
        self.db.rollback()
        return rows

    def asset_status(self, asset) -> str:
        self.reload(asset)
        return asset.status

    # --- sending the OTP ----------------------------------------------------------

    def test_otp_goes_to_the_requests_mobile_and_is_logged_masked(self):
        lease = self.lease()

        response = self.send(lease)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["sent_to"], f"ending {lease.mobile[-2:]}")
        self.db.rollback()
        sessions = self.db.query(OTPSession).filter(OTPSession.mobile == lease.mobile).all()
        self.assertEqual([s.purpose for s in sessions], [f"issue:{lease.id}"])
        logged = self.db.query(NotificationLog).filter(
            NotificationLog.type == "otp_login", NotificationLog.recipient_mobile.like(f"%{lease.mobile}")
        ).one()
        self.assertNotIn(CODE, logged.message)
        self.db.rollback()
        self.assertEqual(self.audit_count(lease, "handover_otp_sent"), 1)

    def test_only_staff_who_issue_devices_at_that_center(self):
        lease = self.lease()

        self.assertEqual(self.send(lease, user=self.approver).status_code, 403)
        self.assertEqual(self.send(lease, user=self.other_manager).status_code, 403)  # not their center
        self.assertEqual(self.client.post(f"/api/v1/lease-requests/{lease.id}/handover/send-otp",
                                          json={"center_id": self.center.id}).status_code, 401)
        # A manager may issue from their own center for a request whose pickup center is elsewhere.
        self.assertEqual(self.send(lease, user=self.other_manager, center=self.other_center).status_code, 200)

    def test_request_must_have_devices_waiting(self):
        cases = {
            "pending": (self.lease("pending"), 400),
            "rejected": (self.lease("rejected"), 400),
            "expired": (self.lease("expired"), 400),
            "fully issued": (self.lease("issued", [self.make_asset(status="leased").id]), 400),
            "partly issued": (self.lease("issued", [self.make_asset(status="leased").id, None]), 200),
        }
        for name, (lease, expected) in cases.items():
            with self.subTest(name):
                response = self.send(lease)
                self.assertEqual(response.status_code, expected, response.text)
        self.assertIn("re-approve", self.send(cases["expired"][0]).json()["detail"])

    def test_resend_waits_for_the_cooldown_and_is_limited_per_day(self):
        lease = self.lease()
        self.assertEqual(self.send(lease).status_code, 200)
        again = self.send(lease)
        self.assertEqual(again.status_code, 429, again.text)
        self.assertIn("wait", again.json()["detail"])

        other = self.lease()
        for _ in range(MAX_HANDOVER_OTPS_PER_REQUEST_PER_DAY):
            self.db.add(OTPSession(mobile=other.mobile, otp_code="x", purpose=f"issue:{other.id}", is_used=True,
                                   expires_at=datetime.now(UTC) + timedelta(minutes=5)))
        self.db.commit()
        limited = self.send(other)
        self.assertEqual(limited.status_code, 429, limited.text)
        self.assertIn("today", limited.json()["detail"])

    # --- checking the code -----------------------------------------------------------

    def test_wrong_codes_say_how_many_tries_are_left_then_the_code_is_cancelled(self):
        lease = self.lease()
        self.send(lease)

        responses = [self.verify(lease, otp="000000") for _ in range(5)]

        # 400, not 401: on the staff screens 401 means "your login expired".
        self.assertEqual([r.status_code for r in responses], [400, 400, 400, 400, 429])
        self.assertEqual(responses[0].json()["detail"], "Incorrect OTP. 4 tries left.")
        self.assertEqual(responses[3].json()["detail"], "Incorrect OTP. 1 try left.")
        self.assertEqual(self.verify(lease).status_code, 400)  # the right code no longer works
        self.assertEqual(self.verifications(lease), [])
        self.assertEqual(self.audit_count(lease, "handover_otp_failed"), 6)

    def test_a_code_releases_only_the_request_it_was_sent_for(self):
        first = self.lease()
        second = self.lease(mobile=first.mobile)
        self.send(first)

        self.assertEqual(self.verify(second).status_code, 400)
        self.assertEqual(self.verify(first).status_code, 200)

    # --- issuing ---------------------------------------------------------------------

    def test_issue_after_the_otp(self):
        lease = self.lease()
        device = self.make_asset()
        self.send(lease)

        verified = self.verify(lease)
        response = self.issue(lease, [line(self.sku.id, device.id)], status="active")

        self.assertEqual(verified.status_code, 200, verified.text)
        self.assertEqual(verified.json()["expires_in"], 30 * 60)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.asset_status(device), "leased")
        [verification] = self.verifications(lease)
        self.assertEqual((verification.verified_by, verification.center_id), (self.center_manager.id, self.center.id))
        self.assertIsNotNone(verification.used_at)
        self.assertEqual(self.audit_count(lease, "handover_otp_verified"), 1)
        self.db.rollback()
        issue_entry = self.db.query(AuditLog).filter(AuditLog.entity_id == lease.id, AuditLog.action == "request_updated").one()
        self.assertEqual(issue_entry.new_value["handover_verification_id"], verification.id)
        self.db.rollback()

    def test_issue_without_the_otp_is_refused_and_changes_nothing(self):
        lease = self.lease()
        device = self.make_asset()

        response = self.issue(lease, [line(self.sku.id, device.id)], status="active")

        self.assertEqual(response.status_code, 428, response.text)
        self.assertIn("OTP", response.json()["detail"])
        self.assertEqual(self.asset_status(device), "available")
        self.assertEqual([item.asset_id for item in self.items(lease)], [None])
        self.assertEqual(lease.status, "approved")
        self.assertEqual(self.sms_count(lease, "device_issued_user"), 0)

    def test_one_otp_one_handover(self):
        lease = self.lease(lines=[None, None])
        first, second = self.make_asset(), self.make_asset()
        self.confirm_handover(self.center_manager, lease)

        partial = self.issue(lease, [line(self.sku.id, first.id), line(self.sku.id)])
        rest = self.issue(lease, [line(self.sku.id, first.id), line(self.sku.id, second.id)], status="active")

        self.assertEqual(partial.status_code, 200, partial.text)
        self.assertEqual(rest.status_code, 428, rest.text)
        self.assertEqual(self.asset_status(second), "available")

    def test_otp_entered_by_one_staff_member_does_not_let_another_issue(self):
        lease = self.lease()
        device = self.make_asset()
        self.confirm_handover(self.center_manager, lease)

        response = self.issue(lease, [line(self.sku.id, device.id)], user=self.colleague)

        self.assertEqual(response.status_code, 428, response.text)

    def test_verification_lapses_after_30_minutes(self):
        lease = self.lease()
        device = self.make_asset()
        self.confirm_handover(self.center_manager, lease, minutes=-1)

        response = self.issue(lease, [line(self.sku.id, device.id)])

        self.assertEqual(response.status_code, 428, response.text)

    def test_a_failed_issue_keeps_the_verification(self):
        lease = self.lease()
        broken, good = self.make_asset(status="repair"), self.make_asset()
        self.confirm_handover(self.center_manager, lease)

        refused = self.issue(lease, [line(self.sku.id, broken.id)])
        accepted = self.issue(lease, [line(self.sku.id, good.id)], status="active")

        self.assertEqual(refused.status_code, 400, refused.text)
        self.assertEqual(accepted.status_code, 200, accepted.text)
        [verification] = self.verifications(lease)
        self.assertIsNotNone(verification.used_at)

    def test_saves_that_do_not_issue_devices_need_no_otp(self):
        pending = self.lease("pending")
        approved = self.lease()

        approve = self.patch_as(self.approver, pending, {"status": "approved"})
        notes = self.patch_as(self.approver, approved, {"notes": "Collect after 4 pm"})

        self.assertEqual(approve.status_code, 200, approve.text)
        self.assertEqual(notes.status_code, 200, notes.text)
