import uuid

from fastapi.testclient import TestClient
from sqlalchemy import text

import lease_test_support as support
from app.leasing import build_fulfillment_plan, release_holds_for_issued
from app.main import app
from app.models import Center, LeaseItem, LeaseRequest, SKUBlock
from app.security import create_access_token


class ItemPickupCenterTests(support.LeaseApiTestCase):
    """The referrer's mobile on the request form, and a pickup center chosen for each device."""

    def body(self, items, **overrides) -> dict:
        return {
            "requestor_name": "Pickup Test Requestor",
            "mobile": support.random_mobile(),
            "aadhar_number": "999988887777",
            "patient_name": "Pickup Test Patient",
            "delivery_address": "1 Test Street",
            "reference_name": "Dr Test",
            "expected_duration": "1 Week",
            "items": items,
            **support.FORM_FIELDS,
            **overrides,
        }

    def submit(self, items, **overrides):
        response = self.client.post("/api/v1/lease-requests", json=self.body(items, **overrides))
        if response.status_code == 200:
            self.lease_ids.append(response.json()["id"])
        return response

    def item(self, sku, center) -> dict:
        return {"sku_id": sku.id, "quantity_requested": 1, "pickup_center_id": center.id}

    def lease(self, response) -> LeaseRequest:
        self.db.rollback()
        lease = self.db.get(LeaseRequest, response.json()["id"])
        self.db.refresh(lease)
        return lease

    def staff_rows(self) -> dict:
        client = TestClient(app, cookies={"access_token": create_access_token(self.approver.id)})
        return {row["id"]: row for row in client.get("/api/v1/lease-requests").json()}

    def free_at(self, sku, center) -> int:
        self.db.rollback()
        row = self.db.execute(
            text("SELECT available_count FROM sku_stock_by_center WHERE sku_id = :s AND center_id = :c"),
            {"s": sku.id, "c": center.id},
        ).first()
        self.db.rollback()
        return int(row[0]) if row else 0

    def use_up(self, sku, center) -> None:
        """Hold every free unit of a model at a center for another request."""
        holder = self.make_lease("pending", [(sku, None)])
        for _ in range(self.free_at(sku, center)):
            self.db.add(SKUBlock(lease_request_id=holder.id, sku_id=sku.id, center_id=center.id, status="blocked"))
        self.db.commit()
        self.assertEqual(self.free_at(sku, center), 0)

    # --- referrer's mobile -----------------------------------------------------------------

    def test_referrer_mobile_is_required_and_shown_to_staff_only(self):
        self.make_asset()
        missing = self.submit([self.item(self.sku, self.center)], reference_mobile=None)
        short = self.submit([self.item(self.sku, self.center)], reference_mobile="98765")
        ok = self.submit([self.item(self.sku, self.center)], reference_mobile="9876512345")

        self.assertEqual(missing.status_code, 400, missing.text)
        self.assertIn("referrer's mobile", missing.json()["detail"])
        self.assertEqual(short.status_code, 422, short.text)
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(self.lease(ok).reference_mobile, "9876512345")
        self.assertEqual(self.staff_rows()[ok.json()["id"]]["reference_mobile"], "9876512345")
        public = self.verified_client(ok.json()["mobile"]).get(f"/api/v1/lease-requests/by-token/{ok.json()['token_number']}")
        self.assertNotIn("reference_mobile", public.json())

    # --- choosing a center per device ---------------------------------------------------------

    def test_each_device_is_held_at_the_center_chosen_for_it(self):
        self.make_asset(center=self.center)
        self.make_asset(sku=self.other_sku, center=self.other_center)
        before = (self.free_at(self.sku, self.center), self.free_at(self.other_sku, self.other_center))

        response = self.submit([self.item(self.sku, self.center), self.item(self.other_sku, self.other_center)])

        self.assertEqual(response.status_code, 200, response.text)
        lease = self.lease(response)
        self.assertEqual(lease.preferred_center_id, self.center.id)  # the first device's center
        lines = {line.sku_id: line.pickup_center_id for line in self.items(lease)}
        self.assertEqual(lines, {self.sku.id: self.center.id, self.other_sku.id: self.other_center.id})
        holds = {(hold.sku_id, hold.center_id) for hold in self.holds(lease)}
        self.assertEqual(holds, {(self.sku.id, self.center.id), (self.other_sku.id, self.other_center.id)})
        after = (self.free_at(self.sku, self.center), self.free_at(self.other_sku, self.other_center))
        self.assertEqual(after, (before[0] - 1, before[1] - 1))
        row = self.staff_rows()[lease.id]
        self.assertEqual(
            sorted((item["sku_name"], item["pickup_center_name"]) for item in row["items"]),
            sorted([(self.sku.name, self.center.name), (self.other_sku.name, self.other_center.name)]),
        )

    def test_a_device_not_free_at_the_chosen_center_is_refused(self):
        self.use_up(self.other_sku, self.center)
        mobile = support.random_mobile()

        response = self.submit([self.item(self.other_sku, self.center)], mobile=mobile)

        self.assertEqual(response.status_code, 409, response.text)
        self.assertIn(f"no longer available at {self.center.name}", response.json()["detail"])
        self.db.rollback()
        self.assertEqual(self.db.query(LeaseRequest).filter(LeaseRequest.mobile == mobile).count(), 0)

    def test_two_of_the_same_device_need_two_free_units(self):
        self.use_up(self.other_sku, self.other_center)
        self.make_asset(sku=self.other_sku, center=self.other_center)  # exactly one free unit

        response = self.submit([self.item(self.other_sku, self.other_center), self.item(self.other_sku, self.other_center)])

        self.assertEqual(response.status_code, 409, response.text)

    def test_older_forms_use_the_preferred_center_for_every_device(self):
        self.make_asset()
        response = self.submit([{"sku_id": self.sku.id, "quantity_requested": 1}], preferred_center_id=self.center.id)
        nowhere = self.submit([{"sku_id": self.sku.id, "quantity_requested": 1}])
        bad_center = self.submit([{"sku_id": self.sku.id, "quantity_requested": 1, "pickup_center_id": "no-such-center"}])

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([line.pickup_center_id for line in self.items(self.lease(response))], [self.center.id])
        self.assertEqual(nowhere.status_code, 400, nowhere.text)
        self.assertIn("choose where to collect", nowhere.json()["detail"])
        self.assertEqual(bad_center.status_code, 400, bad_center.text)

    def test_an_inactive_center_cannot_be_chosen(self):
        closed = Center(name="Pickup Test Closed Center", city="Test", is_active=False)
        self.db.add(closed)
        self.db.commit()

        def remove_closed_center():
            self.db.rollback()
            self.db.query(Center).filter(Center.id == closed.id).delete()
            self.db.commit()

        self.addCleanup(remove_closed_center)

        response = self.submit([self.item(self.sku, closed)])

        self.assertEqual(response.status_code, 400, response.text)

    # --- the pickup plan, edits and re-approval ----------------------------------------------------------

    def test_pickup_plan_follows_the_chosen_center_while_it_has_the_device(self):
        # The other center has more units, which is where the plan used to send people.
        for _ in range(4):
            self.make_asset(center=self.other_center)
        self.make_asset(center=self.center)
        lease = self.lease(self.submit([self.item(self.sku, self.center)]))

        centers, _ = build_fulfillment_plan(self.db, lease.id)

        self.assertEqual([c["center_id"] for c in centers], [self.center.id])

    def test_edits_and_issuing_keep_each_devices_center(self):
        self.make_asset(sku=self.other_sku, center=self.other_center)
        self.make_asset()
        lease = self.lease(self.submit([self.item(self.sku, self.center), self.item(self.other_sku, self.other_center)]))

        edit = self.patch_as(self.approver, lease, {"notes": "[Approver Edit] same devices", "items": [
            {"sku_id": self.sku.id, "quantity_requested": 1},
            {"sku_id": self.other_sku.id, "quantity_requested": 1},
        ]})
        self.patch_as(self.approver, lease, {"status": "approved"})
        device = self.make_asset()
        self.confirm_handover(self.center_manager, lease)
        issue = self.patch_as(self.center_manager, lease, {"status": "approved", "items": [
            {"sku_id": self.sku.id, "quantity_requested": 1, "asset_id": device.id},
            {"sku_id": self.other_sku.id, "quantity_requested": 1},
        ]})

        self.assertEqual(edit.status_code, 200, edit.text)
        self.assertEqual(issue.status_code, 200, issue.text)
        lines = {line.sku_id: (line.pickup_center_id, line.asset_id) for line in self.items(lease)}
        self.assertEqual(lines, {self.sku.id: (self.center.id, device.id), self.other_sku.id: (self.other_center.id, None)})

    def blocked(self, lease) -> list[tuple[str, str]]:
        self.db.rollback()
        rows = [(h.sku_id, h.center_id) for h in self.holds(lease) if h.status == "blocked"]
        self.db.rollback()
        return sorted(rows)

    def issue_partly(self, lease, device, sku):
        """Issue one device on a two-line request, leaving the other line open (the request stays approved)."""
        self.confirm_handover(self.center_manager, lease)
        other = self.other_sku if sku is self.sku else self.sku
        response = self.patch_as(self.center_manager, lease, {"status": "approved", "items": [
            {"sku_id": sku.id, "quantity_requested": 1, "asset_id": device.id},
            {"sku_id": other.id, "quantity_requested": 1},
        ]})
        self.assertEqual(response.status_code, 200, response.text)

    def test_a_partly_issued_request_holds_only_its_open_lines(self):
        self.make_asset(sku=self.other_sku, center=self.other_center)
        lease = self.lease(self.submit([self.item(self.sku, self.center), self.item(self.other_sku, self.other_center)]))
        self.patch_as(self.approver, lease, {"status": "approved"})
        device = self.make_asset()
        free_before = self.free_at(self.sku, self.center)
        self.assertEqual(self.blocked(lease), sorted([(self.sku.id, self.center.id), (self.other_sku.id, self.other_center.id)]))

        self.issue_partly(lease, device, self.sku)

        self.assertEqual(self.blocked(lease), [(self.other_sku.id, self.other_center.id)])
        # The issued device is counted once (leased), not twice (leased and still held).
        self.assertEqual(self.free_at(self.sku, self.center), free_before)
        self.reload(lease)
        self.assertEqual(lease.status, "approved")

    def test_the_hold_released_is_the_one_at_the_devices_center_else_the_oldest(self):
        # Only staff without a center (admins) can issue from another center, so the choice is checked directly.
        lease = self.make_lease("approved", [None, None])
        for center in (self.center, self.other_center):
            self.db.add(SKUBlock(lease_request_id=lease.id, sku_id=self.sku.id, center_id=center.id, status="blocked"))
        self.db.commit()

        release_holds_for_issued(self.db, lease, [(self.sku.id, self.other_center.id)])
        self.db.commit()
        self.assertEqual(self.blocked(lease), [(self.sku.id, self.center.id)])

        # A device from a center with no hold for it releases the request's remaining (oldest) hold for the model.
        release_holds_for_issued(self.db, lease, [(self.sku.id, str(uuid.uuid4()))])
        self.db.commit()
        self.assertEqual(self.blocked(lease), [])

    def test_re_approval_holds_at_each_devices_center(self):
        self.make_asset(sku=self.other_sku, center=self.other_center)
        lease = self.make_lease("expired", [(self.other_sku, None)])
        self.db.query(LeaseItem).filter(LeaseItem.lease_request_id == lease.id).update({"pickup_center_id": self.other_center.id})
        self.db.commit()

        response = self.patch_as(self.approver, lease, {"status": "approved"})

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([(h.sku_id, h.center_id) for h in self.holds(lease)], [(self.other_sku.id, self.other_center.id)])
