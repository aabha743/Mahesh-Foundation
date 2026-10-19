"""Aadhaar card photos sent with a request.

In production they go to a private Cloud Storage bucket (AADHAR_PHOTO_BUCKET), reached with the VM's own
service account through the metadata server, so no key file is needed. In development and tests they go to
a local folder named by AADHAR_PHOTO_DIR. With neither set, nothing is stored and submissions are refused:
the server never falls back to its own disk, where a deploy would delete the photos.
"""

import base64
import binascii
import logging
import os
import threading
import time
from pathlib import Path
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

MAX_PHOTO_BYTES = 1_500_000
MIN_PHOTO_BYTES = 1_000
# What the browser may send: JPEG, PNG or WebP, recognised by the file's first bytes.
_SIGNATURES = (
    (b"\xff\xd8\xff", "image/jpeg", "jpg"),
    (b"\x89PNG\r\n\x1a\n", "image/png", "png"),
)
_METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
_STORAGE_API = "https://storage.googleapis.com/storage/v1/b"
_UPLOAD_API = "https://storage.googleapis.com/upload/storage/v1/b"
_TIMEOUT = httpx.Timeout(20.0, connect=5.0)


class InvalidPhoto(ValueError):
    """The upload is not a usable photo; the message is shown to the person submitting."""


class PhotoStorageError(RuntimeError):
    """Photos could not be saved, read or deleted (storage unreachable or not configured)."""


class PhotoNotFound(PhotoStorageError):
    pass


def decode_photo(data: str, label: str) -> tuple[bytes, str, str]:
    """Turn a base64 photo (optionally a data: URL) into (bytes, content type, file extension)."""
    if "," in data[:100] and data.startswith("data:"):
        data = data.split(",", 1)[1]
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise InvalidPhoto(f"The {label} could not be read. Please choose the photo again.") from None
    if len(raw) > MAX_PHOTO_BYTES:
        raise InvalidPhoto(f"The {label} is too large. Please use a photo under 1.5 MB.")
    if len(raw) < MIN_PHOTO_BYTES:
        raise InvalidPhoto(f"The {label} is too small to read. Please take the photo again.")
    for signature, content_type, extension in _SIGNATURES:
        if raw.startswith(signature):
            return raw, content_type, extension
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return raw, "image/webp", "webp"
    raise InvalidPhoto(f"The {label} must be a JPEG, PNG or WebP image.")


def _bucket() -> str | None:
    return os.getenv("AADHAR_PHOTO_BUCKET", "").strip() or None


def _local_dir() -> Path:
    configured = os.getenv("AADHAR_PHOTO_DIR", "").strip()
    if not configured:
        raise PhotoStorageError(
            "no photo storage configured: set AADHAR_PHOTO_BUCKET (production) or AADHAR_PHOTO_DIR (development)"
        )
    return Path(configured)


def _local_path(name: str) -> Path:
    base = _local_dir().resolve()
    path = (base / name).resolve()
    if base not in path.parents:
        raise PhotoStorageError(f"invalid photo name {name!r}")
    return path


# --- Cloud Storage over its JSON API -------------------------------------------------------------

_token_lock = threading.Lock()
_token: tuple[str, float] | None = None  # (access token, monotonic time it expires)


def _access_token() -> str:
    global _token
    with _token_lock:
        if _token and _token[1] - time.monotonic() > 60:
            return _token[0]
        try:
            response = httpx.get(_METADATA_TOKEN_URL, headers={"Metadata-Flavor": "Google"}, timeout=5.0)
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise PhotoStorageError(f"could not get a storage access token: {error}") from None
        _token = (body["access_token"], time.monotonic() + int(body.get("expires_in", 300)))
        return _token[0]


def _object_url(bucket: str, name: str) -> str:
    return f"{_STORAGE_API}/{quote(bucket, safe='')}/o/{quote(name, safe='')}"


def _gcs(method: str, url: str, **kwargs) -> httpx.Response:
    try:
        return httpx.request(method, url, headers={"Authorization": f"Bearer {_access_token()}",
                                                   **kwargs.pop("headers", {})}, timeout=_TIMEOUT, **kwargs)
    except httpx.HTTPError as error:
        raise PhotoStorageError(f"storage request failed: {error}") from None


# --- what the rest of the app uses ------------------------------------------------------------------

def save_photo(name: str, data: bytes, content_type: str) -> None:
    bucket = _bucket()
    if bucket:
        response = _gcs(
            "POST",
            f"{_UPLOAD_API}/{quote(bucket, safe='')}/o",
            # ifGenerationMatch=0: never overwrite an existing object.
            params={"uploadType": "media", "name": name, "ifGenerationMatch": "0"},
            headers={"Content-Type": content_type},
            content=data,
        )
        if response.status_code != 200:
            raise PhotoStorageError(f"upload of {name} failed: HTTP {response.status_code} {response.text[:200]}")
        return
    path = _local_path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def load_photo(name: str) -> tuple[bytes, str]:
    """The photo's bytes and content type."""
    bucket = _bucket()
    if bucket:
        response = _gcs("GET", _object_url(bucket, name), params={"alt": "media"})
        if response.status_code == 404:
            raise PhotoNotFound(name)
        if response.status_code != 200:
            raise PhotoStorageError(f"download of {name} failed: HTTP {response.status_code}")
        return response.content, response.headers.get("content-type", "application/octet-stream")
    path = _local_path(name)
    if not path.is_file():
        raise PhotoNotFound(name)
    data = path.read_bytes()
    content_type = next((ct for sig, ct, _ in _SIGNATURES if data.startswith(sig)), "image/webp")
    return data, content_type


def delete_photo(name: str) -> None:
    """Delete a photo; one that is already gone counts as deleted."""
    bucket = _bucket()
    if bucket:
        response = _gcs("DELETE", _object_url(bucket, name))
        if response.status_code not in (200, 204, 404):
            raise PhotoStorageError(f"delete of {name} failed: HTTP {response.status_code}")
        return
    _local_path(name).unlink(missing_ok=True)
