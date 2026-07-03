import unittest
from types import SimpleNamespace

from fastapi import HTTPException

from app.main import (
    enforce_center_resource_access,
    enforce_user_self_management_rules,
    get_effective_permissions,
    invalidate_permission_cache,
    is_center_scoped_operator,
)


def make_user(
    user_id: str,
    center_id: str | None,
    permissions: list[str],
):
    role = SimpleNamespace(
        permissions=[SimpleNamespace(action=permission) for permission in permissions]
    )
    return SimpleNamespace(id=user_id, center_id=center_id, roles=[role])


class ResourceAuthorizationTests(unittest.TestCase):
    def tearDown(self):
        invalidate_permission_cache("center-user")
        invalidate_permission_cache("admin-user")

    def test_center_scoped_operator_detected_from_operational_permissions(self):
        user = make_user(
            "center-user",
            "center-a",
            ["assets.update", "devices.issue", "devices.collect"],
        )

        self.assertTrue(is_center_scoped_operator(user, db=None))

    def test_non_center_scoped_operator_not_restricted_when_permissions_are_broader(self):
        user = make_user(
            "admin-user",
            "center-a",
            ["assets.update", "devices.issue", "devices.collect", "users.manage"],
        )

        self.assertFalse(is_center_scoped_operator(user, db=None))

    def test_center_scoped_operator_can_access_own_center_resources(self):
        user = make_user(
            "center-user",
            "center-a",
            ["assets.update", "devices.issue", "devices.collect"],
        )

        enforce_center_resource_access(user, None, "center-a", "center-b")

    def test_center_scoped_operator_cannot_access_other_center_resources(self):
        user = make_user(
            "center-user",
            "center-a",
            ["assets.update", "devices.issue", "devices.collect"],
        )

        with self.assertRaises(HTTPException) as exc:
            enforce_center_resource_access(user, None, "center-b")

        self.assertEqual(exc.exception.status_code, 403)
        self.assertEqual(exc.exception.detail, "Resource does not belong to your center")

    def test_self_management_blocks_self_deactivation(self):
        user = make_user("center-user", "center-a", ["users.manage"])

        with self.assertRaises(HTTPException) as exc:
            enforce_user_self_management_rules(user, "center-user", is_active=False)

        self.assertEqual(exc.exception.status_code, 400)
        self.assertEqual(exc.exception.detail, "You cannot deactivate your own account")

    def test_self_management_blocks_self_role_change(self):
        user = make_user("center-user", "center-a", ["users.manage"])

        with self.assertRaises(HTTPException) as exc:
            enforce_user_self_management_rules(
                user,
                "center-user",
                role_names=["master_admin"],
            )

        self.assertEqual(exc.exception.status_code, 400)
        self.assertEqual(exc.exception.detail, "You cannot change your own roles")

    def test_self_management_allows_updates_for_other_users(self):
        user = make_user("admin-user", "center-a", ["users.manage"])

        enforce_user_self_management_rules(
            user,
            "other-user",
            is_active=False,
            role_names=["center_manager"],
        )

    def test_permission_cache_can_be_recomputed_after_invalidation(self):
        user = make_user("center-user", "center-a", ["assets.update"])

        self.assertEqual(get_effective_permissions(user, db=None), {"assets.update"})

        user.roles[0].permissions = [SimpleNamespace(action="devices.collect")]
        invalidate_permission_cache("center-user")

        self.assertEqual(get_effective_permissions(user, db=None), {"devices.collect"})


if __name__ == "__main__":
    unittest.main()
