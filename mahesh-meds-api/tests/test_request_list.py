"""The staff request list: filters, pages, center scope, counts, one request, devices out, and Aadhaar masking."""
import uuid

from fastapi.testclient import TestClient

import lease_test_support as support
from app.main import app
from app.models import AuditLog, LeaseItem, LeaseRequest
from app.security import create_access_token


class RequestListTests(support.LeaseApiTestCase):
    def get(self, user, path="/api/v1/lease-requests", **params):
        return TestClient(app, cookies={"access_token": create_access_token(user.id)}).get(path, params=params)

    def rows(self, user, **params) -> list[dict]:
        response = self.get(user, **params)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def ids(self, user, **params) -> set[str]:
        return {row["id"] for row in self.rows(user, limit=200, **params)}

    def counts(self, user, **params) -> dict:
        response = self.get(user, "/api/v1/lease-requests/counts", **params)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def picked_up_at(self, center, status="pending") -> LeaseRequest:
        """An open request whose device is to be collected from `center` (a free unit is there)."""
        self.make_asset(center=center)
        lease = self.make_lease(status, [None])
        self.db.query(LeaseItem).filter(LeaseItem.lease_request_id == lease.id).update({"pickup_center_id": center.id})
        self.db.commit()
        return lease

    def device_from(self, center, status="issued", returned=False) -> LeaseRequest:
        """A request with a device whose home center is `center`."""
        device = self.make_asset(center=center, status="available" if returned else "leased")
        lease = self.make_lease(status, [device.id])
        if returned:
            self.db.query(LeaseItem).filter(LeaseItem.lease_request_id == lease.id).update({"returned_at": support.utcnow()})
            self.db.commit()
        return lease

    # --- which requests ------------------------------------------------------------------------

    def test_a_center_gets_only_the_requests_it_works_on(self):
        to_collect = self.picked_up_at(self.other_center)
        out = self.device_from(self.other_center)
        returned = self.device_from(self.other_center, status="returned", returned=True)
        elsewhere = self.picked_up_at(self.center)

        found = self.ids(self.approver, center_id=self.other_center.id)

        self.assertTrue({to_collect.id, out.id, returned.id} <= found)
        self.assertNotIn(elsewhere.id, found)
        self.assertIn(elsewhere.id, self.ids(self.approver))  # no center asked for: every center's

    def test_a_center_manager_only_ever_gets_their_own_center(self):
        theirs = self.picked_up_at(self.center)
        other = self.device_from(self.other_center)

        found = self.ids(self.center_manager)
        other_center = self.get(self.center_manager, center_id=self.other_center.id)
        one_of_theirs = self.get(self.center_manager, f"/api/v1/lease-requests/{theirs.id}")
        one_of_another = self.get(self.center_manager, f"/api/v1/lease-requests/{other.id}")

        self.assertIn(theirs.id, found)
        self.assertNotIn(other.id, found)
        self.assertEqual(other_center.status_code, 403, other_center.text)
        self.assertEqual(one_of_theirs.status_code, 200, one_of_theirs.text)
        self.assertEqual(one_of_another.status_code, 404, one_of_another.text)

    def test_statuses_and_pages(self):
        approved = [self.picked_up_at(self.other_center, status="approved") for _ in range(3)]
        issued = self.device_from(self.other_center, status="issued")
        partly_returned = self.device_from(self.other_center, status="partially_returned")

        first = self.rows(self.approver, center_id=self.other_center.id, status="approved", limit=2)
        rest = self.rows(self.approver, center_id=self.other_center.id, status="approved", limit=2, offset=2)
        active = self.rows(self.approver, center_id=self.other_center.id, status="active", limit=200)

        self.assertEqual(len(first), 2)
        self.assertEqual({row["id"] for row in first} & {row["id"] for row in rest}, set())
        self.assertTrue({lease.id for lease in approved} <= {row["id"] for row in first + rest})
        self.assertEqual({row["status"] for row in first + rest}, {"approved"})
        self.assertTrue({issued.id, partly_returned.id} <= {row["id"] for row in active})
        self.assertEqual({row["status"] for row in active}, {"active"})
        both = self.ids(self.approver, center_id=self.other_center.id, status="approved, active")
        self.assertTrue({issued.id, approved[0].id} <= both)
        self.assertEqual(self.get(self.approver, status="lost").status_code, 400)
        self.assertEqual(self.get(self.approver, limit=201).status_code, 422)

    def test_one_request(self):
        lease = self.picked_up_at(self.center)

        response = self.get(self.approver, f"/api/v1/lease-requests/{lease.id}")
        missing = self.get(self.approver, f"/api/v1/lease-requests/{uuid.uuid4()}")

        self.assertEqual(response.status_code, 200, response.text)
        row = response.json()
        self.assertEqual((row["id"], row["token_number"], row["status"]), (lease.id, lease.token_number, "pending"))
        self.assertEqual([item["pickup_center_id"] for item in row["items"]], [self.center.id])
        self.assertEqual(missing.status_code, 404, missing.text)

    # --- Aadhaar numbers ---------------------------------------------------------------------------

    def test_only_reviewers_get_full_aadhaar_numbers(self):
        lease = self.picked_up_at(self.center)
        lease.patient_aadhar_number = "999911112222"
        self.db.commit()

        def numbers(user) -> list[tuple[str, str]]:
            listed = next(row for row in self.rows(user, limit=200) if row["id"] == lease.id)
            one = self.get(user, f"/api/v1/lease-requests/{lease.id}").json()
            return [(row["aadhar_number"], row["patient_aadhar_number"]) for row in (listed, one)]

        self.assertEqual(numbers(self.approver), [("999988887777", "999911112222")] * 2)
        self.assertEqual(numbers(self.center_manager), [("********7777", "********2222")] * 2)

    # --- counts -------------------------------------------------------------------------------

    def test_counts_per_status_and_active_devices_per_center(self):
        before = self.counts(self.approver, center_id=self.other_center.id)

        self.picked_up_at(self.other_center)
        self.device_from(self.other_center)
        self.picked_up_at(self.center)  # another center's
        after = self.counts(self.approver, center_id=self.other_center.id)

        self.assertEqual(after["total"], before["total"] + 2)
        self.assertEqual(after["by_status"]["pending"], before["by_status"]["pending"] + 1)
        self.assertEqual(after["by_status"]["active"], before["by_status"]["active"] + 1)
        self.assertEqual(after["active_by_center"].get(self.other_center.id, 0),
                         before["active_by_center"].get(self.other_center.id, 0) + 1)
        self.assertEqual(set(after["by_status"]), {"pending", "approved", "rejected", "expired", "active", "closed"})
        everyone = self.counts(self.approver)
        self.assertEqual(everyone["total"], sum(everyone["by_status"].values()))
        self.assertGreaterEqual(everyone["total"], after["total"])

    def test_a_center_managers_counts_are_their_centers(self):
        self.device_from(self.other_center)

        counts = self.counts(self.center_manager)

        self.assertTrue(set(counts["active_by_center"]) <= {self.center.id})
        self.assertEqual(self.get(self.center_manager, "/api/v1/lease-requests/counts",
                                  center_id=self.other_center.id).status_code, 403)

    # --- devices out at a center -------------------------------------------------------------------

    def test_devices_out_on_loan_at_a_center(self):
        out = self.device_from(self.other_center)
        back = self.device_from(self.other_center, status="returned", returned=True)

        response = self.get(self.approver, "/api/v1/lease-requests/open-items", center_id=self.other_center.id)

        self.assertEqual(response.status_code, 200, response.text)
        by_request = {row["lease_request_id"]: row for row in response.json()}
        self.assertIn(out.id, by_request)
        self.assertNotIn(back.id, by_request)
        self.assertEqual((by_request[out.id]["token_number"], by_request[out.id]["requestor_name"]),
                         (out.token_number, "Lease Test Requestor"))
        self.assertEqual(self.get(self.approver, "/api/v1/lease-requests/open-items").status_code, 400)

    # --- the activity log ---------------------------------------------------------------------------

    def test_opening_the_list_is_not_logged(self):
        def views() -> int:
            self.db.rollback()
            return self.db.query(AuditLog).filter(AuditLog.action == "requests_list_viewed").count()

        before = views()
        self.rows(self.approver)
        self.counts(self.approver)

        self.assertEqual(views(), before)
