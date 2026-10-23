"""Editing a center (PATCH /api/v1/centers/{id}), as the Centers page's edit form does."""
import unittest
import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.models import AuditLog, Center, Role, User
from app.permissions import invalidate_permission_cache
from app.security import create_access_token
from lease_test_support import CSRF, random_mobile


class CenterUpdateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = SessionLocal()
        roles = {role.name: role for role in cls.db.query(Role).all()}
        cls.admin = User(name="Center Test Admin", mobile=random_mobile(), roles=[roles["master_admin"]])
        cls.manager = User(name="Center Test Manager", mobile=random_mobile(), roles=[roles["center_manager"]])
        cls.db.add_all([cls.admin, cls.manager])
        cls.db.commit()

    @classmethod
    def tearDownClass(cls):
        db = cls.db
        db.rollback()
        for user in (cls.admin, cls.manager):
            invalidate_permission_cache(user.id)
            db.query(AuditLog).filter(AuditLog.user_id == user.id).delete()
            user.roles = []
            db.flush()
            db.delete(user)
        db.commit()
        db.close()

    def setUp(self):
        self.db.rollback()
        self.center = Center(name=f"Center Edit Test {uuid.uuid4().hex[:8]}", city="Secunderabad", state="Telangana")
        self.db.add(self.center)
        self.db.commit()
        self.addCleanup(self.remove_center, self.center.id)

    def remove_center(self, center_id: str):
        self.db.rollback()
        self.db.query(AuditLog).filter(AuditLog.entity_id == center_id).delete()
        self.db.query(Center).filter(Center.id == center_id).delete()
        self.db.commit()

    def client_for(self, user: User) -> TestClient:
        return TestClient(app, cookies={"access_token": create_access_token(user.id), "csrf_token": CSRF})

    def patch_as(self, user: User, body: dict, center_id: str | None = None):
        return self.client_for(user).patch(f"/api/v1/centers/{center_id or self.center.id}", json=body,
                                           headers={"X-CSRF-Token": CSRF})

    def saved(self) -> Center:
        self.db.rollback()  # read what the API committed, not this session's snapshot
        return self.db.get(Center, self.center.id)

    def audit_rows(self) -> list[AuditLog]:
        self.db.rollback()
        return self.db.query(AuditLog).filter(AuditLog.entity_id == self.center.id).all()

    def test_edit_form_save_updates_the_center(self):
        # Exactly what CentersPage.tsx sends when the edit drawer is saved.
        body = {
            "name": self.center.name, "address": "1 Test Road, Secunderabad", "city": "Secunderabad",
            "state": "Telangana", "pin_code": "500003", "contact_person": "Test Contact",
            "contact_phone": "9876543210", "is_active": True,
        }

        response = self.patch_as(self.admin, body)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["contact_person"], "Test Contact")
        center = self.saved()
        self.assertEqual((center.address, center.pin_code, center.contact_person, center.contact_phone),
                         ("1 Test Road, Secunderabad", "500003", "Test Contact", "9876543210"))
        [audit] = self.audit_rows()
        self.assertEqual((audit.action, audit.user_id, audit.center_id), ("center_updated", self.admin.id, center.id))
        # Only what changed is recorded, with its old and new values (write_audit_log adds who made the change).
        self.assertEqual(audit.old_value, {"address": None, "pin_code": None, "contact_person": None, "contact_phone": None})
        changed = {key: audit.new_value[key] for key in audit.new_value if not key.startswith("actor_")}
        self.assertEqual(changed, {"address": "1 Test Road, Secunderabad", "pin_code": "500003",
                                   "contact_person": "Test Contact", "contact_phone": "9876543210"})

    def test_fields_left_out_stay_as_they_are(self):
        response = self.patch_as(self.admin, {"contact_phone": "9876543210"})

        self.assertEqual(response.status_code, 200, response.text)
        center = self.saved()
        self.assertEqual((center.city, center.state, center.contact_phone), ("Secunderabad", "Telangana", "9876543210"))

    def test_saving_without_changes_writes_no_audit_event(self):
        response = self.patch_as(self.admin, {"name": self.center.name, "city": "Secunderabad"})

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.audit_rows(), [])

    def test_only_users_who_manage_centers_can_edit(self):
        refused = self.patch_as(self.manager, {"city": "Elsewhere"})
        no_csrf = self.client_for(self.admin).patch(f"/api/v1/centers/{self.center.id}", json={"city": "Elsewhere"})
        no_login = TestClient(app).patch(f"/api/v1/centers/{self.center.id}", json={"city": "Elsewhere"})

        self.assertEqual(refused.status_code, 403, refused.text)
        self.assertEqual(no_csrf.status_code, 403, no_csrf.text)
        self.assertIn(no_login.status_code, (401, 403), no_login.text)
        self.assertEqual(self.saved().city, "Secunderabad")

    def test_unknown_center(self):
        response = self.patch_as(self.admin, {"city": "Elsewhere"}, center_id=str(uuid.uuid4()))

        self.assertEqual(response.status_code, 404, response.text)

    def test_values_that_do_not_fit_are_refused(self):
        for body in (
            {"contact_phone": "9" * 16},
            {"pin_code": "5" * 11},
            {"city": "C" * 101},
            {"name": "N" * 151},
            {"name": "   "},
            {"name": None},
            {"is_active": None},
        ):
            with self.subTest(body=body):
                response = self.patch_as(self.admin, body)
                self.assertEqual(response.status_code, 422, response.text)
        center = self.saved()
        self.assertEqual((center.name.startswith("Center Edit Test"), center.city, center.is_active), (True, "Secunderabad", True))
        self.assertEqual(self.audit_rows(), [])

    def test_creating_a_center_refuses_values_that_do_not_fit(self):
        response = self.client_for(self.admin).post("/api/v1/centers", headers={"X-CSRF-Token": CSRF}, json={
            "name": f"Center Create Test {uuid.uuid4().hex[:8]}", "city": "Secunderabad", "contact_phone": "9" * 16,
        })

        self.assertEqual(response.status_code, 422, response.text)
