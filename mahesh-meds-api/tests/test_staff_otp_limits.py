from datetime import UTC, datetime, timedelta
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import text

import lease_test_support as support
from app.main import app
from app.models import AuditLog, NotificationLog, OTPSession
from app.otp import WRONG_CODES_DETAIL
from app.routers.auth import LOGIN_LOCKED_DETAIL, OTP_SENT_MESSAGE

CODE = "642042"


class StaffOtpLimitTests(support.LeaseApiTestCase):
    """Staff login: caps per number and per device, a lockout after repeated wrong codes, no hint about which
    numbers are staff; and a per-device limit on wrong codes on every OTP screen."""

    def setUp(self):
        super().setUp()
        self.mobiles = [self.center_manager.mobile, self.approver.mobile]
        self.devices: list[str] = []
        patcher = patch("app.otp.generate_otp", return_value=CODE)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.db.rollback()
        self.db.query(OTPSession).filter(OTPSession.mobile.in_(self.mobiles)).delete(synchronize_session=False)
        self.db.query(NotificationLog).filter(
            NotificationLog.recipient_mobile.in_([f"91{m}" for m in self.mobiles] + self.mobiles)
        ).delete(synchronize_session=False)
        user_ids = [self.center_manager.id, self.approver.id]
        self.db.query(AuditLog).filter(
            (AuditLog.entity_id.in_(user_ids)) | (AuditLog.ip_address.in_(self.devices or ["-"]))
            | (AuditLog.action == "otp_requested_unregistered")
        ).delete(synchronize_session=False)
        self.db.commit()

    def device(self, address: str) -> TestClient:
        """A browser at its own address; its audit rows are removed afterwards."""
        self.devices.append(address)
        return TestClient(app, client=(address, 50000))

    def request_code(self, mobile, client=None):
        return (client or self.client).post("/auth/request-otp", json={"mobile": mobile})

    def verify(self, mobile, otp, client=None):
        return (client or self.client).post("/auth/verify-otp", json={"mobile": mobile, "otp": otp})

    def seed_codes(self, mobile, count, hours_ago=0):
        for _ in range(count):
            self.db.add(OTPSession(mobile=mobile, otp_code="x", purpose="login", is_used=True,
                                   expires_at=datetime.now(UTC) + timedelta(minutes=5)))
        self.db.commit()
        if hours_ago:
            self.db.execute(text("UPDATE otp_sessions SET created_at = NOW() - INTERVAL :h HOUR WHERE mobile = :m"),
                            {"h": hours_ago, "m": mobile})
            self.db.commit()

    def seed_audit(self, action, ip, count, **values):
        for _ in range(count):
            self.db.add(AuditLog(action=action, entity_type="user", ip_address=ip, new_value=values or None))
        self.db.commit()
        self.devices.append(ip)

    # --- unknown numbers -----------------------------------------------------------------------------

    def test_unknown_numbers_get_the_same_replies_and_no_code(self):
        unknown = support.random_mobile()
        self.mobiles.append(unknown)

        staff = self.request_code(self.center_manager.mobile)
        stranger = self.request_code(unknown)
        staff_again = self.request_code(self.center_manager.mobile)
        stranger_again = self.request_code(unknown)

        self.assertEqual((staff.status_code, staff.json()), (stranger.status_code, stranger.json()))
        self.assertEqual(stranger.json()["message"], OTP_SENT_MESSAGE)
        self.assertEqual((staff_again.status_code, staff_again.json()), (stranger_again.status_code, stranger_again.json()))
        self.assertEqual(stranger_again.status_code, 429)
        self.db.rollback()
        self.assertEqual(self.db.query(OTPSession).filter(OTPSession.mobile == unknown).count(), 0)
        self.assertEqual(
            self.db.query(NotificationLog).filter(NotificationLog.recipient_mobile.like(f"%{unknown}")).count(), 0
        )

    # --- caps per number and device -----------------------------------------------------------------

    def test_five_codes_an_hour_and_ten_a_day_per_number(self):
        self.seed_codes(self.center_manager.mobile, 5)
        hourly = self.request_code(self.center_manager.mobile)
        self.db.rollback()
        self.db.query(OTPSession).filter(OTPSession.mobile == self.center_manager.mobile).delete()
        self.db.commit()
        self.seed_codes(self.center_manager.mobile, 10, hours_ago=3)
        daily = self.request_code(self.center_manager.mobile)

        self.assertEqual(hourly.status_code, 429, hourly.text)
        self.assertIn("in an hour", hourly.json()["detail"])
        self.assertEqual(daily.status_code, 429, daily.text)
        self.assertIn("today", daily.json()["detail"])

    def test_twenty_code_requests_an_hour_per_device(self):
        busy, other = self.device("198.18.251.7"), self.device("198.18.251.8")
        self.seed_audit("otp_requested", "198.18.251.7", 20)
        with patch("app.routers.auth.MAX_LOGIN_OTP_REQUESTS_PER_DEVICE_PER_HOUR", 20):
            blocked = self.request_code(self.center_manager.mobile, client=busy)
            allowed = self.request_code(self.center_manager.mobile, client=other)

        self.assertEqual(blocked.status_code, 429, blocked.text)
        self.assertIn("this device", blocked.json()["detail"])
        self.assertEqual(allowed.status_code, 200, allowed.text)

    # --- lockout ------------------------------------------------------------------------------------------

    def test_three_cancelled_codes_lock_the_number_for_a_day(self):
        replies = []
        for _ in range(3):
            self.assertEqual(self.request_code(self.center_manager.mobile).status_code, 200)
            replies = [self.verify(self.center_manager.mobile, "000000") for _ in range(5)]

        self.assertEqual(replies[-1].status_code, 429, replies[-1].text)
        self.assertEqual(replies[-1].json()["detail"], LOGIN_LOCKED_DETAIL)
        locked = self.request_code(self.center_manager.mobile)
        self.assertEqual(locked.status_code, 429, locked.text)
        self.assertEqual(locked.json()["detail"], LOGIN_LOCKED_DETAIL)
        self.assertEqual(self.request_code(self.approver.mobile).status_code, 200)  # other staff are not affected
        self.db.rollback()
        self.assertEqual(self.db.query(AuditLog).filter(
            AuditLog.action == "otp_login_locked", AuditLog.entity_id == self.center_manager.id).count(), 1)

    def test_the_lock_ends_after_24_hours(self):
        self.db.add(AuditLog(action="otp_login_locked", entity_type="user", entity_id=self.center_manager.id))
        self.db.commit()
        self.assertEqual(self.request_code(self.center_manager.mobile).status_code, 429)

        self.db.rollback()  # leave the snapshot taken before the API's writes
        self.db.execute(text("UPDATE audit_log SET created_at = NOW() - INTERVAL 25 HOUR "
                             "WHERE action = 'otp_login_locked' AND entity_id = :u"), {"u": self.center_manager.id})
        self.db.commit()
        self.assertEqual(self.request_code(self.center_manager.mobile).status_code, 200)

    # --- wrong codes per device, on every OTP screen ------------------------------------------------------

    def test_wrong_codes_from_one_device_block_it_on_every_otp_screen(self):
        blocked, other = self.device("198.18.252.9"), self.device("198.18.252.10")
        # One wrong code each on the tracking, handover and staff login screens.
        for action in ("track_otp_failed", "handover_otp_failed", "otp_verification_failed"):
            self.seed_audit(action, "198.18.252.9", 1)
        self.request_code(self.center_manager.mobile)

        with patch("app.otp.MAX_WRONG_CODES_PER_DEVICE_PER_HOUR", 3):
            login = self.verify(self.center_manager.mobile, CODE, client=blocked)
            tracking = blocked.post("/api/v1/track/verify-otp", json={"query": self.center_manager.mobile, "otp": CODE})
            elsewhere = self.verify(self.center_manager.mobile, CODE, client=other)

        self.assertEqual((login.status_code, login.json()["detail"]), (429, WRONG_CODES_DETAIL))
        self.assertEqual(tracking.status_code, 429, tracking.text)
        self.assertEqual(elsewhere.status_code, 200, elsewhere.text)  # the blocked device did not use up the code
