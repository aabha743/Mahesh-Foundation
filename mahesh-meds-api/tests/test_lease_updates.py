import unittest
from types import SimpleNamespace

import lease_test_support as support
from app.permissions import required_lease_permission
from app.models import Asset
from app.schemas import LeaseRequestUpdate


def line(sku_id: str, asset_id: str | None = None) -> dict:
    return {"sku_id": sku_id, "quantity_requested": 1, "asset_id": asset_id}


class RequiredLeasePermissionTests(unittest.TestCase):
    """The permission follows from what the update changes, not from the payload's shape alone."""

    def check(self, payload: dict, lease_status: str, assigned_before: list[str | None], expected: str):
        update = LeaseRequestUpdate(**payload)
        lease = SimpleNamespace(status=lease_status)
        existing = [SimpleNamespace(asset_id=asset_id) for asset_id in assigned_before]
        self.assertEqual(required_lease_permission(update, lease, existing), expected, payload)

    def test_mapping(self):
        self.check({"status": "approved"}, "pending", [None], "requests.approve")
        self.check({"status": "approved"}, "expired", [None], "requests.approve")
        self.check({"status": "rejected", "rejection_reason": "x"}, "pending", [None], "requests.reject")
        # Approver changing quantities: no device changes -> edit, not collect.
        self.check({"notes": "[Approver Edit] qty", "items": [line("s1")]}, "pending", [None], "requests.edit")
        # Partial issue sends status "approved" but assigns a device -> issue, not approve.
        self.check({"status": "approved", "items": [line("s1", "a1"), line("s2")]}, "approved", [None, None], "devices.issue")
        self.check({"status": "active", "items": [line("s1", "a1"), line("s2", "a2")]}, "approved", ["a1", None], "devices.issue")
        self.check({"items": [line("s1")]}, "issued", ["a1"], "devices.collect")
        self.check({"status": "closed"}, "issued", ["a1"], "devices.collect")
        self.check({"status": "active", "notes": "Partial return: 1 items returned, 1 still leased"}, "issued", ["a1", "a2"], "devices.collect")
        # Re-sending the same devices changes nothing about devices.
        self.check({"status": "approved", "items": [line("s1", "a1")]}, "approved", ["a1"], "requests.edit")


class LeaseUpdateApiTests(support.LeaseApiTestCase):
    """Approver edits, center-manager issuing (partial and full) and the guards around assigning devices."""

    def issue(self, lease, lines, status="approved", user=None):
        return self.patch_as(user or self.center_manager, lease, {"status": status, "items": lines})

    def asset_status(self, asset: Asset) -> str:
        self.reload(asset)
        return asset.status

    # --- approver edit -----------------------------------------------------

    def test_approver_can_edit_items_of_pending_request(self):
        lease = self.make_lease("pending", [None])

        response = self.patch_as(self.approver, lease, {
            "notes": "[Approver Edit] patient needs two",
            "items": [{"sku_id": self.sku.id, "quantity_requested": 2}],
        })

        self.assertEqual(response.status_code, 200, response.text)
        [item] = self.items(lease)
        self.assertEqual(item.quantity_requested, 2)
        self.assertEqual(lease.notes, "[Approver Edit] patient needs two")

    def test_center_manager_cannot_edit_request_items(self):
        lease = self.make_lease("pending", [None])

        response = self.patch_as(self.center_manager, lease, {"notes": "x", "items": [{"sku_id": self.sku.id, "quantity_requested": 2}]})

        self.assertEqual(response.status_code, 403, response.text)

    # --- issuing -------------------------------------------------------------

    def test_center_manager_partial_issue(self):
        lease = self.make_lease("approved", [None, (self.other_sku, None)], hold_release_at=support.utcnow())
        device = self.make_asset()

        response = self.issue(lease, [line(self.sku.id, device.id), line(self.other_sku.id)])

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "approved")
        self.assertEqual(self.asset_status(device), "leased")
        issued = [item for item in self.items(lease) if item.asset_id]
        self.assertEqual([(item.asset_id, item.issued_by) for item in issued], [(device.id, self.center_manager.id)])
        # A partial issue is not an approval: no repeat approval SMS or approval audit entry.
        self.assertEqual(self.sms_count(lease, "request_approved_user"), 0)
        self.assertEqual(self.audit_count(lease, "approve_request"), 0)

    def test_completing_a_partial_issue_marks_request_issued(self):
        first = self.make_asset(status="leased")
        lease = self.make_lease("approved", [first.id, (self.other_sku, None)], hold_release_at=support.utcnow())
        second = self.make_asset(sku=self.other_sku)

        response = self.issue(lease, [line(self.sku.id, first.id), line(self.other_sku.id, second.id)], status="active")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "active")
        self.assertEqual(self.asset_status(second), "leased")
        [hold] = self.holds(lease)
        self.assertEqual((hold.status, hold.release_reason), ("released", "approved_collected"))
        self.assertEqual(self.sms_count(lease, "device_issued_user"), 1)

    def test_issuing_against_pending_request_is_refused(self):
        lease = self.make_lease("pending", [None])
        device = self.make_asset()

        response = self.issue(lease, [line(self.sku.id, device.id)], status="active")

        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("approved request", response.json()["detail"])
        self.assertEqual(self.asset_status(device), "available")

    def test_device_on_another_open_request_is_refused(self):
        device = self.make_asset(status="leased")
        self.make_lease("issued", [device.id])
        lease = self.make_lease("approved", [None])

        response = self.issue(lease, [line(self.sku.id, device.id)])

        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("already issued on another request", response.json()["detail"])

    def test_device_under_repair_is_refused(self):
        device = self.make_asset(status="repair")
        lease = self.make_lease("approved", [None])

        response = self.issue(lease, [line(self.sku.id, device.id)])

        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("not available", response.json()["detail"])
        self.assertEqual(self.asset_status(device), "repair")

    def test_wrong_model_is_refused(self):
        device = self.make_asset(sku=self.other_sku)
        lease = self.make_lease("approved", [None])

        response = self.issue(lease, [line(self.sku.id, device.id)])

        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("not the requested model", response.json()["detail"])

    def test_center_manager_cannot_issue_another_centers_device(self):
        device = self.make_asset(center=self.other_center)
        lease = self.make_lease("approved", [None])

        response = self.issue(lease, [line(self.sku.id, device.id)], status="active")

        self.assertEqual(response.status_code, 403, response.text)
        self.assertIn("not at your center", response.json()["detail"])
        self.assertEqual(self.asset_status(device), "available")

    def test_same_device_on_two_lines_is_refused(self):
        device = self.make_asset()
        lease = self.make_lease("approved", [None, None])

        response = self.issue(lease, [line(self.sku.id, device.id), line(self.sku.id, device.id)])

        self.assertEqual(response.status_code, 400, response.text)

    def test_device_marked_leased_by_older_frontend_is_accepted(self):
        # Before this change the frontend marked devices leased in separate calls before the update.
        device = self.make_asset(status="leased")
        lease = self.make_lease("approved", [None])

        response = self.issue(lease, [line(self.sku.id, device.id)], status="active")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "active")

    # --- approving -----------------------------------------------------------

    def test_center_manager_cannot_approve(self):
        lease = self.make_lease("pending", [None])

        response = self.patch_as(self.center_manager, lease, {"status": "approved"})

        self.assertEqual(response.status_code, 403, response.text)

    def test_approval_sms_is_sent_once(self):
        lease = self.make_lease("pending", [None])

        first = self.patch_as(self.approver, lease, {"status": "approved"})
        again = self.patch_as(self.approver, lease, {"status": "approved"})

        self.assertEqual((first.status_code, again.status_code), (200, 200), again.text)
        self.assertEqual(self.sms_count(lease, "request_approved_user"), 1)
        self.assertEqual(self.audit_count(lease, "approve_request"), 1)

    # --- pickup guidance -----------------------------------------------------

    def test_finished_requests_have_no_pickup_guidance(self):
        rejected = self.make_lease("rejected", [None])
        issued = self.make_lease("issued", [self.make_asset(status="leased").id])

        for lease in (rejected, issued):
            payload = self.client.get(f"/api/v1/lease-requests/by-token/{lease.token_number}").json()
            self.assertEqual((payload["fulfillment_centers"], payload["fulfillment_message"]), ([], None), lease.status)

    def test_approved_request_keeps_pickup_guidance(self):
        self.make_asset()
        lease = self.make_lease("approved", [None])

        payload = self.client.get(f"/api/v1/lease-requests/by-token/{lease.token_number}").json()

        self.assertTrue(payload["fulfillment_message"])
        self.assertIn(self.center.id, [center["center_id"] for center in payload["fulfillment_centers"]])


if __name__ == "__main__":
    unittest.main()
