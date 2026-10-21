import re
import threading
import unittest
import uuid
from datetime import UTC, date, datetime, timedelta
from unittest.mock import patch

import jwt
from fastapi.testclient import TestClient
from sqlalchemy import text

import lease_test_support as support
from app.database import SessionLocal, engine
from app.leasing import INDIA_TIME, MONTH_CODES, next_token_number
from app.main import app
from app.migrate import MIGRATIONS_DIR, statements
from app.models import AuditLog, LeaseExtension, NotificationLog, OTPSession
from app.routers.track import MAX_OTP_REQUESTS_PER_DEVICE_PER_HOUR, MAX_OTPS_PER_NUMBER_PER_DAY
from app.security import JWT_ALGORITHM, JWT_SECRET, TRACK_COOKIE

CODE = "424242"


class TrackingOtpTests(support.LeaseApiTestCase):
    """Phase 2: server-issued MF-<month>-<number> tokens, and OTP before the public can see or extend a request."""

    def setUp(self):
        super().setUp()
        self.mobiles: list[str] = []
        patcher = patch("app.otp.generate_otp", return_value=CODE)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.cleanup_tracking_rows)

    def cleanup_tracking_rows(self):
        self.db.rollback()
        if self.mobiles:
            self.db.query(OTPSession).filter(OTPSession.mobile.in_(self.mobiles)).delete(synchronize_session=False)
            self.db.query(NotificationLog).filter(NotificationLog.recipient_mobile.in_([f"91{m}" for m in self.mobiles] + self.mobiles)).delete(synchronize_session=False)
        self.db.query(AuditLog).filter(AuditLog.action.like("track_otp%")).delete(synchronize_session=False)
        self.db.commit()

    def lease(self, status="issued", mobile=None):
        lease = self.make_lease(status, [self.make_asset(status="leased").id] if status == "issued" else [None])
        if mobile:
            lease.mobile = mobile
            self.db.commit()
        self.mobiles.append(lease.mobile)
        return lease

    def send(self, query, client=None):
        return (client or self.client).post("/api/v1/track/send-otp", json={"query": query})

    def verify(self, query, otp=CODE, client=None):
        return (client or self.client).post("/api/v1/track/verify-otp", json={"query": query, "otp": otp})

    # --- tokens ----------------------------------------------------------------

    def submit(self, **overrides):
        self.make_asset()  # a submission holds one free device at its pickup center
        body = {
            "token_number": "MDF-CLIENT1",
            "requestor_name": "Token Test", "mobile": support.random_mobile(), "aadhar_number": "999988887777",
            "patient_name": "P", "delivery_address": "A", "reference_name": "R",
            "preferred_center_id": self.center.id, "expected_duration": "1 Week",
            "items": [{"sku_id": self.sku.id, "quantity_requested": 1}], **support.FORM_FIELDS, **overrides,
        }
        response = self.client.post("/api/v1/lease-requests", json=body)
        self.assertEqual(response.status_code, 200, response.text)
        self.lease_ids.append(response.json()["id"])
        return response.json()["token_number"]

    def test_server_issues_consecutive_tokens_and_ignores_the_browsers(self):
        first, second = self.submit(), self.submit()

        month = MONTH_CODES[datetime.now(UTC).astimezone(INDIA_TIME).month - 1]
        for token in (first, second):
            self.assertRegex(token, rf"^MF-{month}-\d{{4,}}$")
        self.assertEqual(int(second.rsplit("-", 1)[1]), int(first.rsplit("-", 1)[1]) + 1)

    def test_month_follows_india_time(self):
        db = SessionLocal()
        try:
            late_utc = datetime(2026, 8, 31, 19, 0, tzinfo=UTC)  # 1 Sept, 00:30 in India
            self.assertTrue(next_token_number(db, late_utc).startswith("MF-SEP-"))
        finally:
            db.close()

    def test_tokens_do_not_repeat_under_concurrency(self):
        tokens: list[str] = []

        def take():
            db = SessionLocal()
            try:
                tokens.append(next_token_number(db))
            finally:
                db.close()

        threads = [threading.Thread(target=take) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(set(tokens)), 8)

    # --- sending the OTP -------------------------------------------------------

    def test_token_sends_otp_to_the_requests_mobile_and_logs_it_masked(self):
        lease = self.lease()

        response = self.send(lease.token_number.lower())

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["sent_to"], f"ending {lease.mobile[-2:]}")
        self.db.rollback()
        self.assertEqual(self.db.query(OTPSession).filter(OTPSession.mobile == lease.mobile, OTPSession.purpose == "track").count(), 1)
        logged = self.db.query(NotificationLog).filter(NotificationLog.type == "mf_tracking_otp", NotificationLog.recipient_mobile.like(f"%{lease.mobile}")).one()
        self.assertNotIn(CODE, logged.message)
        self.assertIn("******", logged.message)

    def test_unknown_number_gets_the_same_reply_but_no_otp(self):
        mobile = support.random_mobile()
        self.mobiles.append(mobile)

        response = self.send(mobile)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["sent_to"], f"ending {mobile[-2:]}")
        self.db.rollback()
        self.assertEqual(self.db.query(OTPSession).filter(OTPSession.mobile == mobile).count(), 0)

    def test_unknown_token_and_bad_input(self):
        self.assertEqual(self.send("MF-JAN-999999").status_code, 404)
        self.assertEqual(self.send("12345").status_code, 400)

    def test_resend_waits_for_the_cooldown(self):
        lease = self.lease()

        self.assertEqual(self.send(lease.mobile).status_code, 200)
        again = self.send(lease.mobile)

        self.assertEqual(again.status_code, 429, again.text)
        self.assertIn("wait", again.json()["detail"])

    def test_daily_limit_per_number(self):
        lease = self.lease()
        for _ in range(MAX_OTPS_PER_NUMBER_PER_DAY):
            self.db.add(OTPSession(mobile=lease.mobile, otp_code="x", purpose="track", is_used=True,
                                   expires_at=datetime.now(UTC) + timedelta(minutes=5)))
        self.db.commit()

        response = self.send(lease.mobile)

        self.assertEqual(response.status_code, 429, response.text)
        self.assertIn("today", response.json()["detail"])

    def test_hourly_limit_per_device(self):
        lease = self.lease()
        for _ in range(MAX_OTP_REQUESTS_PER_DEVICE_PER_HOUR):
            self.db.add(AuditLog(action="track_otp_requested", entity_type="token", ip_address="testclient"))
        self.db.commit()

        response = self.send(lease.mobile)

        self.assertEqual(response.status_code, 429, response.text)
        self.assertIn("device", response.json()["detail"])

    # --- verifying and viewing -------------------------------------------------

    def test_verified_browser_sees_only_its_numbers_requests(self):
        mine, other = self.lease(), self.lease()
        browser = TestClient(app)
        self.send(mine.token_number, browser)

        response = self.verify(mine.token_number, client=browser)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn(TRACK_COOKIE, browser.cookies)
        self.assertEqual(browser.get(f"/api/v1/lease-requests/by-token/{mine.token_number}").status_code, 200)
        self.assertEqual(browser.get(f"/api/v1/lease-requests/by-mobile/{mine.mobile}").status_code, 200)
        self.assertEqual(browser.get(f"/api/v1/lease-requests/by-token/{other.token_number}").status_code, 401)
        self.assertEqual(browser.get(f"/api/v1/lease-requests/by-mobile/{other.mobile}").status_code, 401)

        browser.post("/api/v1/track/logout")
        self.assertEqual(browser.get(f"/api/v1/lease-requests/by-token/{mine.token_number}").status_code, 401)

    def test_lookups_need_otp_or_staff(self):
        lease = self.lease()
        url = f"/api/v1/lease-requests/by-token/{lease.token_number}"

        self.assertEqual(self.client.get(url).status_code, 401)
        self.assertIn("OTP", self.client.get(url).json()["detail"])
        staff = TestClient(app, cookies={"access_token": support.create_access_token(self.approver.id)})
        self.assertEqual(staff.get(url).status_code, 200)

    def test_expired_or_forged_session_is_refused(self):
        lease = self.lease()
        url = f"/api/v1/lease-requests/by-token/{lease.token_number}"
        expired = jwt.encode({"mobile": lease.mobile, "type": "track", "exp": datetime.now(UTC) - timedelta(minutes=1)},
                             JWT_SECRET, algorithm=JWT_ALGORITHM)
        forged = jwt.encode({"mobile": lease.mobile, "type": "track", "exp": datetime.now(UTC) + timedelta(minutes=5)},
                            "not-the-secret-" * 4, algorithm=JWT_ALGORITHM)

        for token in (expired, forged):
            self.assertEqual(TestClient(app, cookies={TRACK_COOKIE: token}).get(url).status_code, 401)

    def test_wrong_codes_then_lockout_after_five(self):
        lease = self.lease()
        self.send(lease.mobile)

        codes = [self.verify(lease.mobile, otp="000000").status_code for _ in range(5)]

        self.assertEqual(codes, [401, 401, 401, 401, 429])
        self.assertEqual(self.verify(lease.mobile).status_code, 400)  # the right code no longer works

    def test_tracking_session_cannot_log_in_as_staff(self):
        lease = self.lease()
        browser = TestClient(app)
        self.send(lease.mobile, browser)
        self.verify(lease.mobile, client=browser)

        self.assertEqual(browser.get("/me").status_code, 401)

    # --- extension requests ----------------------------------------------------

    def make_due(self, lease):
        lines = self.items(lease)  # reloads (rolls back) first, so set the dates after it
        lease.due_date = date.today() + timedelta(days=3)
        for line in lines:
            line.due_date = lease.due_date
        self.db.commit()

    def extend(self, client, lease):
        return client.post("/api/v1/lease-extensions", json={
            "token_number": lease.token_number,
            "requested_due_date": (date.today() + timedelta(days=8)).isoformat(),
            "reason": "Patient still recovering",
        })

    def delete_extension(self, extension_id: str) -> None:
        self.db.rollback()
        self.db.query(LeaseExtension).filter(LeaseExtension.id == extension_id).delete()
        self.db.commit()

    def test_extension_needs_a_session_for_the_leases_number(self):
        lease = self.lease()
        self.make_due(lease)

        self.assertEqual(self.extend(self.client, lease).status_code, 401)
        self.assertEqual(self.extend(self.verified_client(support.random_mobile()), lease).status_code, 401)
        response = self.extend(self.verified_client(lease.mobile), lease)

        self.assertEqual(response.status_code, 200, response.text)
        self.db.rollback()
        extension = self.db.get(LeaseExtension, response.json()["id"])
        self.addCleanup(self.delete_extension, extension.id)
        self.assertEqual((extension.mobile, extension.aadhar_number, extension.requestor_name),
                         (lease.mobile, lease.aadhar_number, lease.requestor_name))


class StaffLoginOtpTests(support.LeaseApiTestCase):
    """Staff login shares the OTP code (app/otp.py): exactly 5 tries, and the code is logged masked."""

    def setUp(self):
        super().setUp()
        patcher = patch("app.otp.generate_otp", return_value=CODE)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.db.rollback()
        mobile = self.center_manager.mobile
        self.db.query(OTPSession).filter(OTPSession.mobile == mobile).delete(synchronize_session=False)
        self.db.query(NotificationLog).filter(NotificationLog.recipient_mobile.like(f"%{mobile}")).delete(synchronize_session=False)
        self.db.commit()

    def test_five_tries_and_masked_log(self):
        mobile = self.center_manager.mobile
        self.assertEqual(self.client.post("/auth/request-otp", json={"mobile": mobile}).status_code, 200)

        codes = [self.client.post("/auth/verify-otp", json={"mobile": mobile, "otp": "000000"}).status_code for _ in range(5)]

        self.assertEqual(codes, [401, 401, 401, 401, 429])
        self.db.rollback()
        logged = self.db.query(NotificationLog).filter(NotificationLog.recipient_mobile.like(f"%{mobile}")).all()
        self.assertTrue(logged)
        self.assertFalse(any(CODE in row.message for row in logged))

    def test_right_code_logs_in(self):
        mobile = self.center_manager.mobile
        self.client.post("/auth/request-otp", json={"mobile": mobile})
        browser = TestClient(app)

        response = browser.post("/auth/verify-otp", json={"mobile": mobile, "otp": CODE})

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(browser.get("/me").status_code, 200)


class MigrationThreeTests(unittest.TestCase):
    def test_old_otp_messages_are_masked_and_rerunning_is_harmless(self):
        mobile = "91" + "".join(str(uuid.uuid4().int)[:10])
        with engine.begin() as conn:
            conn.execute(text("INSERT INTO notifications_log (id, recipient_mobile, message, type, status) "
                              "VALUES (UUID(), :m, 'Your OTP for Login is 135790', 'otp_login', 'sent')"), {"m": mobile})
        sql = (MIGRATIONS_DIR / "003_token_counter_and_masked_otps.sql").read_text(encoding="utf-8")
        try:
            for _ in range(2):
                with engine.begin() as conn:
                    for statement in statements(sql):
                        conn.exec_driver_sql(statement)
            with engine.connect() as conn:
                message = conn.execute(text("SELECT message FROM notifications_log WHERE recipient_mobile = :m"), {"m": mobile}).scalar_one()
            self.assertEqual(message, "Your OTP for Login is ******")
            self.assertTrue(re.search(r"\*{6}$", message))
        finally:
            with engine.begin() as conn:
                conn.execute(text("DELETE FROM notifications_log WHERE recipient_mobile = :m"), {"m": mobile})


if __name__ == "__main__":
    unittest.main()
