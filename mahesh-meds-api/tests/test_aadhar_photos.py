import base64
import os
import unittest
import uuid
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import text

import lease_test_support as support
from app import photo_storage
from app.jobs.aadhar_photos import delete_expired_aadhar_photos
from app.main import app
from app.models import AuditLog, LeaseRequest
from app.photo_storage import PhotoNotFound, PhotoStorageError, load_photo
from app.security import create_access_token

PNG = b"\x89PNG\r\n\x1a\n" + bytes(2000)
WEBP = b"RIFF" + bytes(4) + b"WEBP" + bytes(2000)
PDF = b"%PDF-1.7\n" + bytes(2000)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


class AadharPhotoTests(support.LeaseApiTestCase):
    """Phase 4: Aadhaar numbers and card photos for requester and patient, seen only by reviewers."""

    def setUp(self):
        super().setUp()
        self.extra_audit_ids: list[str] = []
        self.addCleanup(self.cleanup_audit_rows)

    def cleanup_audit_rows(self):
        self.db.rollback()
        self.db.query(AuditLog).filter(
            (AuditLog.id.in_(self.extra_audit_ids)) | (AuditLog.action == "request_rate_limited")
        ).delete(synchronize_session=False)
        self.db.commit()

    def body(self, **overrides) -> dict:
        return {
            "requestor_name": "Aadhaar Test Requestor",
            "mobile": support.random_mobile(),
            "aadhar_number": "999988887777",
            "patient_name": "Aadhaar Test Patient",
            "delivery_address": "1 Test Street",
            "reference_name": "Dr Test",
            "preferred_center_id": self.center.id,
            "expected_duration": "1 Week",
            "items": [{"sku_id": self.sku.id, "quantity_requested": 1}],
            **support.AADHAR_FIELDS,
            **overrides,
        }

    def submit(self, client=None, **overrides):
        response = (client or self.client).post("/api/v1/lease-requests", json=self.body(**overrides))
        if response.status_code == 200:
            self.lease_ids.append(response.json()["id"])
        return response

    def lease(self, response) -> LeaseRequest:
        self.db.rollback()
        lease = self.db.get(LeaseRequest, response.json()["id"])
        self.db.refresh(lease)
        return lease

    def leases_for(self, mobile: str) -> int:
        self.db.rollback()
        count = self.db.query(LeaseRequest).filter(LeaseRequest.mobile == mobile).count()
        self.db.rollback()
        return count

    def staff(self, user) -> TestClient:
        return TestClient(app, cookies={"access_token": create_access_token(user.id)})

    def photo(self, lease_id: str, whose: str, user=None, client=None):
        client = client or self.staff(user or self.approver)
        return client.get(f"/api/v1/lease-requests/{lease_id}/aadhar-photo/{whose}")

    # --- submitting ------------------------------------------------------------------

    def test_submission_stores_both_numbers_photos_and_consent(self):
        response = self.submit(patient_aadhar_photo=b64(PNG))

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual((body["aadhar_photos_status"], body["patient_photo_is_requesters"]), ("present", False))
        self.assertNotIn("aadhar_photo", body)  # storage names never leave the server
        lease = self.lease(response)
        self.assertEqual(lease.patient_aadhar_number, "999911112222")
        self.assertIsNotNone(lease.aadhar_consent_at)
        self.assertTrue(lease.aadhar_photo.startswith(f"requests/{lease.id}/requester-"))
        self.assertEqual(load_photo(lease.aadhar_photo), (support.PHOTO_JPEG, "image/jpeg"))
        self.assertEqual(load_photo(lease.patient_aadhar_photo), (PNG, "image/png"))

    def test_requester_who_is_the_patient_gives_one_number_and_photo(self):
        response = self.submit(patient_is_requester=True, patient_aadhar_number=None, patient_aadhar_photo=None)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["patient_photo_is_requesters"])
        lease = self.lease(response)
        self.assertEqual(lease.patient_aadhar_number, lease.aadhar_number)
        self.assertEqual(lease.patient_aadhar_photo, lease.aadhar_photo)

    def test_missing_or_unusable_aadhaar_details_are_refused(self):
        cases = {
            "no consent": ({"aadhar_consent": False}, 400, "consent"),
            "no patient number": ({"patient_aadhar_number": None}, 400, "patient's Aadhaar number"),
            "short patient number": ({"patient_aadhar_number": "12345678901"}, 422, None),
            "no requester photo": ({"aadhar_photo": None}, 400, "requester's Aadhaar card"),
            "no patient photo": ({"patient_aadhar_photo": None}, 400, "patient's Aadhaar card"),
            "a PDF": ({"aadhar_photo": b64(PDF)}, 400, "JPEG, PNG or WebP"),
            "too large": ({"patient_aadhar_photo": b64(b"\xff\xd8\xff" + bytes(1_600_000))}, 400, "too large"),
            "too small": ({"aadhar_photo": b64(b"\xff\xd8\xff\xe0")}, 400, "too small"),
            "not base64": ({"aadhar_photo": "not a photo!"}, 400, "could not be read"),
        }
        for name, (overrides, status, message) in cases.items():
            with self.subTest(name):
                mobile = support.random_mobile()
                response = self.submit(mobile=mobile, **overrides)
                self.assertEqual(response.status_code, status, response.text)
                if message:
                    self.assertIn(message, response.json()["detail"])
                self.assertEqual(self.leases_for(mobile), 0)

    def test_data_urls_png_and_webp_are_accepted(self):
        response = self.submit(aadhar_photo=f"data:image/png;base64,{b64(PNG)}", patient_aadhar_photo=b64(WEBP))

        self.assertEqual(response.status_code, 200, response.text)
        lease = self.lease(response)
        self.assertEqual(load_photo(lease.patient_aadhar_photo)[1], "image/webp")

    def test_storage_failure_leaves_nothing_behind(self):
        real_save, saved, deleted = photo_storage.save_photo, [], []

        def save_first_only(name, data, content_type):
            if saved:
                raise PhotoStorageError("bucket unreachable")
            real_save(name, data, content_type)
            saved.append(name)

        def counter():
            self.db.rollback()
            value = self.db.execute(text("SELECT next_not_cached_value FROM lease_token_seq")).scalar()
            self.db.rollback()
            return value

        mobile = support.random_mobile()
        before = counter()
        with patch("app.routers.lease_requests.save_photo", side_effect=save_first_only), \
                patch("app.routers.lease_requests.delete_photo", side_effect=deleted.append):
            response = self.submit(mobile=mobile)

        self.assertEqual(response.status_code, 503, response.text)
        self.assertEqual(self.leases_for(mobile), 0)
        self.assertEqual(deleted, saved)  # the photo that did get saved is removed again
        self.assertEqual(counter(), before)  # no token number used up

    def test_per_device_limit(self):
        def new_device() -> TestClient:
            return TestClient(app, client=(f"198.51.{uuid.uuid4().int % 250}.{uuid.uuid4().int % 250 + 1}", 50000))

        device = new_device()
        with patch("app.routers.lease_requests.MAX_REQUESTS_PER_DEVICE_PER_HOUR", 2):
            codes = [self.submit(client=device).status_code for _ in range(3)]
            other_device = self.submit(client=new_device()).status_code

        self.assertEqual(codes, [200, 200, 429])
        self.assertEqual(other_device, 200)

    # --- viewing -------------------------------------------------------------------------

    def test_reviewers_see_the_photos_and_each_view_is_logged(self):
        lease_id = self.submit(patient_aadhar_photo=b64(PNG)).json()["id"]

        requester = self.photo(lease_id, "requester")
        patient = self.photo(lease_id, "patient")

        self.assertEqual((requester.status_code, requester.content), (200, support.PHOTO_JPEG))
        self.assertEqual(requester.headers["content-type"], "image/jpeg")
        self.assertIn("no-store", requester.headers["cache-control"])
        self.assertEqual((patient.status_code, patient.content), (200, PNG))
        self.db.rollback()
        self.assertEqual(self.audit_count(self.db.get(LeaseRequest, lease_id), "aadhar_photo_viewed"), 2)

    def test_only_reviewers_can_see_photos(self):
        lease_id = self.submit().json()["id"]

        self.assertEqual(self.photo(lease_id, "requester", user=self.center_manager).status_code, 403)
        self.assertEqual(self.photo(lease_id, "requester", client=self.client).status_code, 401)
        self.assertEqual(self.photo(lease_id, "someone-else").status_code, 404)

    def test_requests_from_before_photos_were_required(self):
        lease = self.make_lease("pending", [None])

        self.assertEqual(self.photo(lease.id, "requester").status_code, 404)
        rows = self.staff(self.approver).get("/api/v1/lease-requests").json()
        row = next(r for r in rows if r["id"] == lease.id)
        self.assertEqual((row["aadhar_photos_status"], row["patient_aadhar_number"]), ("none", None))

    def test_public_lookup_shows_no_photos_or_patient_number(self):
        response = self.submit()
        mobile = response.json()["mobile"]

        found = self.verified_client(mobile).get(f"/api/v1/lease-requests/by-token/{response.json()['token_number']}")

        self.assertEqual(found.status_code, 200, found.text)
        self.assertNotIn("patient_aadhar_number", found.json())
        self.assertNotIn("aadhar_photo", found.json())
        self.assertEqual(found.json()["aadhar_number"], "********7777")

    # --- retention ---------------------------------------------------------------------

    def finished(self, status: str, days_ago: int, **overrides) -> LeaseRequest:
        lease = self.lease(self.submit(**overrides))
        self.db.execute(
            text("UPDATE lease_requests SET status = :status, updated_at = UTC_TIMESTAMP() - INTERVAL :days DAY WHERE id = :id"),
            {"status": status, "days": days_ago, "id": lease.id},
        )
        self.db.commit()
        return lease

    def test_retention_is_off_until_a_period_is_set(self):
        lease = self.finished("rejected", 400)

        for setting in ("", "0"):
            with self.subTest(setting=setting), patch.dict(os.environ, {"AADHAR_PHOTO_RETENTION_DAYS": setting}):
                self.assertEqual(delete_expired_aadhar_photos(), 0)
        self.reload(lease)
        self.assertEqual(lease.aadhar_photos_status, "present")

    def test_retention_deletes_photos_of_finished_requests_but_keeps_numbers(self):
        old_rejected = self.finished("rejected", 31)
        old_returned = self.finished("returned", 40, patient_is_requester=True)
        recent_rejected = self.finished("rejected", 5)
        still_out = self.finished("issued", 90)
        names = [old_rejected.aadhar_photo, old_rejected.patient_aadhar_photo, old_returned.aadhar_photo]

        with patch.dict(os.environ, {"AADHAR_PHOTO_RETENTION_DAYS": "30"}):
            delete_expired_aadhar_photos()

        for lease in (old_rejected, old_returned):
            self.reload(lease)
            self.assertEqual((lease.aadhar_photos_status, lease.aadhar_photo), ("deleted", None))
            self.assertEqual(lease.patient_aadhar_number, "999911112222" if lease is old_rejected else lease.aadhar_number)
            self.assertEqual(self.audit_count(lease, "aadhar_photos_deleted"), 1)
        for name in names:
            with self.assertRaises(PhotoNotFound):
                load_photo(name)
        for lease in (recent_rejected, still_out):
            self.reload(lease)
            self.assertEqual(lease.aadhar_photos_status, "present")
        gone = self.photo(old_rejected.id, "requester")
        self.assertEqual(gone.status_code, 410, gone.text)


class CloudStorageTests(unittest.TestCase):
    """The bucket backend, against a stand-in for the metadata server and the Cloud Storage API."""

    def setUp(self):
        photo_storage._token = None
        self.calls: list[httpx.Request] = []
        env = patch.dict(os.environ, {"AADHAR_PHOTO_BUCKET": "test-bucket"})
        env.start()
        self.addCleanup(env.stop)
        token = patch("app.photo_storage.httpx.get", return_value=httpx.Response(
            200, json={"access_token": "tok", "expires_in": 3600}, request=httpx.Request("GET", "http://metadata")))
        token.start()
        self.addCleanup(token.stop)
        self.addCleanup(setattr, photo_storage, "_token", None)

    def respond(self, status: int, content: bytes = b"", headers=None):
        def fake(method, url, **kwargs):
            request = httpx.Request(method, url, params=kwargs.get("params"), headers=kwargs.get("headers"),
                                    content=kwargs.get("content"))
            self.calls.append(request)
            return httpx.Response(status, content=content, headers=headers, request=request)
        return patch("app.photo_storage.httpx.request", side_effect=fake)

    def test_upload_never_overwrites_and_uses_the_vm_token(self):
        with self.respond(200):
            photo_storage.save_photo("requests/abc/requester-1.jpg", support.PHOTO_JPEG, "image/jpeg")

        [call] = self.calls
        self.assertEqual(call.url.path, "/upload/storage/v1/b/test-bucket/o")
        self.assertEqual(dict(call.url.params), {"uploadType": "media", "name": "requests/abc/requester-1.jpg", "ifGenerationMatch": "0"})
        self.assertEqual(call.headers["authorization"], "Bearer tok")
        self.assertEqual(call.headers["content-type"], "image/jpeg")

    def test_download_and_delete(self):
        with self.respond(200, support.PHOTO_JPEG, {"content-type": "image/jpeg"}):
            self.assertEqual(photo_storage.load_photo("requests/abc/r.jpg"), (support.PHOTO_JPEG, "image/jpeg"))
        self.assertIn("/o/requests%2Fabc%2Fr.jpg", str(self.calls[0].url))
        with self.respond(404), self.assertRaises(PhotoNotFound):
            photo_storage.load_photo("requests/abc/gone.jpg")
        with self.respond(404):
            photo_storage.delete_photo("requests/abc/gone.jpg")  # already gone is fine
        with self.respond(403), self.assertRaises(PhotoStorageError):
            photo_storage.save_photo("requests/abc/r.jpg", support.PHOTO_JPEG, "image/jpeg")

    def test_without_a_bucket_or_folder_nothing_is_stored(self):
        with patch.dict(os.environ, {"AADHAR_PHOTO_BUCKET": "", "AADHAR_PHOTO_DIR": ""}), \
                self.assertRaises(PhotoStorageError):
            photo_storage.save_photo("requests/abc/r.jpg", support.PHOTO_JPEG, "image/jpeg")

    def test_names_cannot_escape_the_local_folder(self):
        with patch.dict(os.environ, {"AADHAR_PHOTO_BUCKET": ""}), self.assertRaises(PhotoStorageError):
            photo_storage.save_photo("../outside.jpg", support.PHOTO_JPEG, "image/jpeg")
