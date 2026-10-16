import unittest
from datetime import date, timedelta
from types import SimpleNamespace

from fastapi.testclient import TestClient

import lease_test_support as support
from app.main import app
from app.security import create_access_token
from app.models import Asset, LeaseItem, LeaseRequest, User


class LeaseReturnTests(support.LeaseApiTestCase):
    """POST /lease-requests/{id}/returns: one transaction for the whole return, and the older return screen still works."""

    def client_for(self, user: User) -> TestClient:
        return TestClient(app, cookies={"access_token": create_access_token(user.id), "csrf_token": support.CSRF})

    def post_return(self, lease: LeaseRequest, devices: list[Asset], condition="Good", user=None, **extra):
        body = {
            "condition": condition,
            "items": [{"asset_id": device.id, "serial_number": device.serial_number} for device in devices],
            **extra,
        }
        return self.client_for(user or self.center_manager).post(
            f"/api/v1/lease-requests/{lease.id}/returns", json=body, headers={"X-CSRF-Token": support.CSRF}
        )

    def patch_asset(self, device: Asset, body: dict):
        return self.client_for(self.center_manager).patch(
            f"/api/v1/assets/{device.id}", json=body, headers={"X-CSRF-Token": support.CSRF}
        )

    def issued_lease(self, count=2, status="issued", notes="Approver note: deliver to ward 3", due_dates=None):
        devices = [self.make_asset(status="leased") for _ in range(count)]
        lease = self.make_lease(status, [device.id for device in devices])
        lines = self.items(lease)
        for line, due in zip(lines, due_dates or [], strict=False):
            line.due_date = due
        lease.notes = notes
        self.db.commit()
        return lease, devices

    def line_for(self, lease: LeaseRequest, device: Asset) -> LeaseItem:
        return next(line for line in self.items(lease) if line.asset_id == device.id)

    def asset_row(self, device: Asset) -> Asset:
        self.reload(device)
        return device

    # --- returning ---------------------------------------------------------

    def test_full_return_closes_request_and_restocks_devices(self):
        lease, devices = self.issued_lease()

        response = self.post_return(lease, devices, checklist=["Device is functional"], notes="all fine")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "closed")
        self.assertEqual(response.json()["still_out"], 0)
        self.reload(lease)
        self.assertEqual(lease.status, "returned")
        self.assertEqual(lease.notes, "Approver note: deliver to ward 3")
        for device in devices:
            line = self.line_for(lease, device)
            self.assertIsNotNone(line.returned_at)
            self.assertEqual(line.returned_to, self.center_manager.id)
            self.assertEqual(line.return_center_id, self.center.id)
            self.assertEqual(line.condition_on_return, "Good; Checked: Device is functional; Notes: all fine")
            self.assertEqual((self.asset_row(device).status, device.center_id), ("available", self.center.id))
        self.assertEqual(self.audit_count(lease, "devices_returned"), 1)

    def test_partial_return_keeps_notes_and_moves_due_date(self):
        soon, later = date.today() + timedelta(days=3), date.today() + timedelta(days=10)
        lease, (first, second) = self.issued_lease(due_dates=[later, soon])
        self.reload(lease)
        returning = first if self.line_for(lease, first).due_date == later else second
        remaining = second if returning is first else first

        response = self.post_return(lease, [returning])

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual((response.json()["status"], response.json()["still_out"]), ("active", 1))
        self.reload(lease)
        self.assertEqual(lease.status, "partially_returned")
        self.assertEqual(lease.due_date, soon)
        self.assertEqual(lease.notes, "Approver note: deliver to ward 3")
        self.assertEqual(self.asset_row(remaining).status, "leased")

        response = self.post_return(lease, [remaining])

        self.assertEqual(response.status_code, 200, response.text)
        self.reload(lease)
        self.assertEqual(lease.status, "returned")
        self.assertEqual(self.audit_count(lease, "devices_returned"), 2)

    def test_damaged_devices_go_under_repair(self):
        for condition in ("Major Damage", "Needs Repair"):
            with self.subTest(condition=condition):
                lease, [device] = self.issued_lease(count=1)

                response = self.post_return(lease, [device], condition=condition, notes="wheel cracked")

                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["returned"][0]["status"], "under_repair")
                self.assertEqual(self.asset_row(device).status, "repair")
                self.assertIn(f"{lease.token_number}: {condition}; Notes: wheel cracked", device.notes)

    def test_minor_damage_goes_back_to_stock(self):
        lease, [device] = self.issued_lease(count=1)

        response = self.post_return(lease, [device], condition="Minor Damage")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.asset_row(device).status, "available")

    def test_returned_lines_are_marked_in_token_lookup(self):
        lease, (first, second) = self.issued_lease()
        self.post_return(lease, [first])

        items = self.client.get(f"/api/v1/lease-requests/by-token/{lease.token_number}").json()["items"]

        returned = {item["asset_id"]: item["returned_at"] for item in items}
        self.assertIsNotNone(returned[first.id])
        self.assertIsNone(returned[second.id])

    def test_partly_issued_request_stays_approved_while_devices_are_out(self):
        devices = [self.make_asset(status="leased") for _ in range(2)]
        lease = self.make_lease("approved", [devices[0].id, devices[1].id, (self.other_sku, None)])

        response = self.post_return(lease, [devices[0]])

        self.assertEqual(response.status_code, 200, response.text)
        self.reload(lease)
        self.assertEqual(lease.status, "approved")

    def test_last_device_back_closes_partly_issued_request_and_releases_holds(self):
        device = self.make_asset(status="leased")
        lease = self.make_lease("approved", [device.id, None], hold_release_at=support.utcnow() + timedelta(hours=72))

        response = self.post_return(lease, [device])

        self.assertEqual(response.status_code, 200, response.text)
        self.reload(lease)
        self.assertEqual(lease.status, "returned")
        self.assertEqual([hold.status for hold in self.holds(lease)], ["released"])

    # --- refusals: nothing is changed ----------------------------------------

    def assert_refused(self, response, status_code: int, detail: str, lease: LeaseRequest, devices: list[Asset]):
        self.assertEqual(response.status_code, status_code, response.text)
        self.assertIn(detail, response.json()["detail"])
        self.reload(lease)
        self.assertEqual(lease.status, "issued")
        for device in devices:
            self.assertEqual(self.asset_row(device).status, "leased")
            self.assertIsNone(self.line_for(lease, device).returned_at)
        self.assertEqual(self.audit_count(lease, "devices_returned"), 0)

    def test_serial_mismatch_refuses_the_whole_return(self):
        lease, (first, second) = self.issued_lease()
        body_devices = [first, SimpleNamespace(id=second.id, serial_number="WRONG-SERIAL")]

        response = self.post_return(lease, body_devices)

        self.assert_refused(response, 400, "does not match", lease, [first, second])

    def test_device_from_another_request_is_refused(self):
        lease, devices = self.issued_lease()
        _, [elsewhere] = self.issued_lease(count=1)

        response = self.post_return(lease, [devices[0], elsewhere])

        self.assert_refused(response, 400, "not out on this request", lease, devices)
        self.assertEqual(self.asset_row(elsewhere).status, "leased")

    def test_device_already_returned_is_refused(self):
        lease, (first, second) = self.issued_lease()
        self.assertEqual(self.post_return(lease, [first]).status_code, 200)

        response = self.post_return(lease, [first, second])

        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("not out on this request", response.json()["detail"])
        self.assertEqual(self.asset_row(second).status, "leased")

    def test_same_device_twice_is_refused(self):
        lease, devices = self.issued_lease()

        response = self.post_return(lease, [devices[0], devices[0]])

        self.assert_refused(response, 400, "more than once", lease, devices)

    def test_unknown_condition_is_refused(self):
        lease, devices = self.issued_lease()

        response = self.post_return(lease, devices, condition="Fine")

        self.assert_refused(response, 400, "condition", lease, devices)

    def test_request_without_devices_out_is_refused(self):
        for status in ("pending", "rejected", "expired", "returned"):
            with self.subTest(status=status):
                device = self.make_asset(status="leased")
                lease = self.make_lease(status, [device.id])

                response = self.post_return(lease, [device])

                self.assertEqual(response.status_code, 400, response.text)
                self.assertIn("no devices out", response.json()["detail"])

    def test_center_manager_cannot_take_back_another_centers_device(self):
        device = self.make_asset(center=self.other_center, status="leased")
        lease = self.make_lease("issued", [device.id])

        response = self.post_return(lease, [device])

        self.assert_refused(response, 403, "does not belong to your center", lease, [device])

    def test_center_manager_cannot_receive_at_another_center(self):
        lease, devices = self.issued_lease()

        response = self.post_return(lease, devices, center_id=self.other_center.id)

        self.assert_refused(response, 403, "your center", lease, devices)

    def test_approver_without_collect_permission_is_refused(self):
        lease, devices = self.issued_lease()

        response = self.post_return(lease, devices, user=self.approver, center_id=self.center.id)

        self.assert_refused(response, 403, "devices.collect", lease, devices)

    # --- other ways a request could be closed ---------------------------------

    def test_device_taken_back_on_assets_page_settles_the_request(self):
        lease, (first, second) = self.issued_lease()

        for device, expected in ((first, "partially_returned"), (second, "returned")):
            response = self.patch_asset(device, {"status": "available", "center_id": self.center.id})
            self.assertEqual(response.status_code, 200, response.text)
            self.reload(lease)
            self.assertEqual(lease.status, expected)
        self.assertEqual(lease.notes, "Approver note: deliver to ward 3")
        self.assertIsNotNone(self.line_for(lease, first).returned_at)

    def test_closing_a_request_directly_is_refused(self):
        lease, devices = self.issued_lease()

        response = self.patch_as(self.center_manager, lease, {"status": "closed"})

        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("Return Device", response.json()["detail"])
        self.reload(lease)
        self.assertEqual(lease.status, "issued")
        self.assertEqual(self.asset_row(devices[0]).status, "leased")

    def test_partial_return_note_is_no_longer_a_collect_action(self):
        lease, _ = self.issued_lease()

        response = self.patch_as(self.center_manager, lease, {
            "status": "active",
            "notes": "Partial return: 1 items returned, 1 still leased",
        })

        # Editing notes needs requests.edit, which center managers do not have.
        self.assertEqual(response.status_code, 403, response.text)
        self.reload(lease)
        self.assertEqual(lease.notes, "Approver note: deliver to ward 3")


if __name__ == "__main__":
    unittest.main()
