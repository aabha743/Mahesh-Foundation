"""Request timelines and report sections read from the activity log (GET /api/v1/audit-logs), and log noise."""
import itertools
import pathlib
import secrets
import unittest
from datetime import datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import text

from app.audit import REPORT_SECTIONS, _section_for_log, section_clause
from app.database import SessionLocal
from app.main import app
from app.migrate import statements
from app.models import AuditLog, Role, User
from app.permissions import invalidate_permission_cache
from app.security import create_access_token
from lease_test_support import random_mobile

MARK = "audit-history-test"  # ip_address of every entry these tests write directly, for clean-up
# Newer than anything else in the test database, so these entries are the newest the API sees.
FUTURE = datetime(2099, 1, 1)
MIGRATION = pathlib.Path(__file__).resolve().parents[1] / "db" / "migrations" / "007_audit_log_token.sql"


class AuditHistoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = SessionLocal()
        roles = {role.name: role for role in cls.db.query(Role).all()}
        cls.admin = User(name="Audit History Admin", mobile=random_mobile(), roles=[roles["master_admin"]])
        cls.db.add(cls.admin)
        cls.db.commit()
        cls.client = TestClient(app, cookies={"access_token": create_access_token(cls.admin.id)})

    @classmethod
    def tearDownClass(cls):
        db = cls.db
        db.rollback()
        invalidate_permission_cache(cls.admin.id)
        db.query(AuditLog).filter(AuditLog.user_id == cls.admin.id).delete()
        cls.admin.roles = []
        db.flush()
        db.delete(cls.admin)
        db.commit()
        db.close()

    def setUp(self):
        self.db.rollback()
        self.addCleanup(self.remove_marked)

    def remove_marked(self):
        self.db.rollback()
        self.db.query(AuditLog).filter(AuditLog.ip_address == MARK).delete()
        self.db.commit()

    def entry(self, action="request_updated", entity_type="lease_request", seconds=0, **values) -> AuditLog:
        row = AuditLog(action=action, entity_type=entity_type, ip_address=MARK, created_at=FUTURE + timedelta(seconds=seconds),
                       new_value=values.get("new_value"), old_value=values.get("old_value"))
        self.db.add(row)
        self.db.commit()
        return row

    def logs(self, **params) -> list[dict]:
        response = self.client.get("/api/v1/audit-logs", params=params)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    # --- the token column -----------------------------------------------------------------------

    def test_the_token_is_stored_in_its_own_column_however_the_entry_is_written(self):
        from_new = self.entry(new_value={"token": "MF-OCT-0042", "status": "approved"})
        from_old = self.entry(old_value={"token": "MF-OCT-0043"})
        without = self.entry(new_value={"status": "approved"})

        self.db.rollback()
        self.assertEqual([self.db.get(AuditLog, row.id).token for row in (from_new, from_old, without)],
                         ["MF-OCT-0042", "MF-OCT-0043", None])

    def test_a_timeline_is_complete_however_many_newer_entries_there_are(self):
        token = f"HT-{secrets.token_hex(4).upper()}"
        for second in range(3):
            self.entry(seconds=second, new_value={"token": token})
        for second in range(3, 9):  # newer entries for other requests
            self.entry(seconds=second, new_value={"token": "MF-OCT-0001"})

        rows = self.logs(token=token, limit=3)

        # The old code took the newest 3 entries of the whole log first, and found none for this token.
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(row["new_value"]["token"] == token for row in rows))

    def test_a_report_section_is_filtered_before_the_row_limit(self):
        decision = self.entry(action="approve_request", seconds=1)
        for second in range(2, 6):
            self.entry(action="user_created", entity_type="user", seconds=second)

        [row] = self.logs(section="approver", limit=1)

        self.assertEqual((row["id"], row["section"]), (decision.id, "approver"))

    def test_the_section_condition_matches_the_section_shown(self):
        actions = ["approve_request", "reject_extension", "request_updated", "center_updated", "user_created"]
        entity_types = ["approval", "approver", "lease_request", "lease_item", "lease_extension", "token", "asset",
                        "center", "admin", "user", "sku", "auth"]
        rows = [self.entry(action=action, entity_type=entity_type)
                for action, entity_type in itertools.product(actions, entity_types)]
        self.db.rollback()
        for section in REPORT_SECTIONS + ("nonsense",):
            with self.subTest(section=section):
                found = {row.id for row in self.db.query(AuditLog).filter(AuditLog.ip_address == MARK, section_clause(section))}
                expected = {row.id for row in rows if _section_for_log(row.entity_type, row.action) == section}
                self.assertEqual(found, expected)
                self.assertTrue(expected or section == "nonsense")

    # --- noise --------------------------------------------------------------------------------

    def refresh_failures(self) -> int:
        self.db.rollback()
        return self.db.query(AuditLog).filter(AuditLog.action == "refresh_failed").count()

    def test_a_visitor_without_a_session_is_not_logged(self):
        before = self.refresh_failures()

        response = TestClient(app).post("/auth/refresh")

        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.refresh_failures(), before)

    def test_a_bad_refresh_token_is_still_logged(self):
        before = self.refresh_failures()

        response = TestClient(app, cookies={"refresh_token": "not-a-real-token-" + secrets.token_hex(8)}).post("/auth/refresh")

        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.refresh_failures(), before + 1)
        newest = self.db.query(AuditLog).filter(AuditLog.action == "refresh_failed").order_by(AuditLog.created_at.desc()).first()
        self.db.delete(newest)
        self.db.commit()

    # --- the migration fills entries written before it ----------------------------------------------

    def test_the_migration_fills_the_token_of_existing_entries(self):
        ids = []
        for new_value in ('{"token": "MF-SEP-0007", "status": "approved"}', '{"token": null}', '{"status": "approved"}'):
            row_id = secrets.token_hex(16)
            self.db.execute(text(
                "INSERT INTO audit_log (id, action, entity_type, new_value, ip_address, created_at) "
                "VALUES (:id, 'request_updated', 'lease_request', :value, :mark, :at)"
            ), {"id": row_id, "value": new_value, "mark": MARK, "at": FUTURE})
            ids.append(row_id)
        self.db.execute(text(
            "INSERT INTO audit_log (id, action, entity_type, old_value, ip_address, created_at) "
            "VALUES (:id, 'request_updated', 'lease_request', '{\"token\": \"MF-SEP-0008\"}', :mark, :at)"
        ), {"id": secrets.token_hex(16), "mark": MARK, "at": FUTURE})
        self.db.commit()

        for statement in statements(MIGRATION.read_text(encoding="utf-8")):
            self.db.execute(text(statement))
        self.db.commit()

        found = dict(self.db.execute(text("SELECT id, token FROM audit_log WHERE ip_address = :mark"), {"mark": MARK}).all())
        self.assertEqual([found[row_id] for row_id in ids], ["MF-SEP-0007", None, None])
        self.assertIn("MF-SEP-0008", found.values())
