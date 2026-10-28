"""Safety net for the test suite.

Several tests insert and delete rows, so they must never run against a real
database. This refuses any DATABASE_URL whose database name does not end in
"_test", and forces SMS off so no test can text a real phone.
"""
import atexit
import os
import shutil
import tempfile

import pytest
from dotenv import load_dotenv
from sqlalchemy.engine import make_url

load_dotenv()

os.environ["SMS_ENABLED"] = "false"
os.environ["SMS_BASE_URL"] = "http://127.0.0.1:9/sms-disabled-in-tests"
os.environ["SMS_STATUS_URL"] = "http://127.0.0.1:9/sms-disabled-in-tests"
# Aadhaar photos go to a throwaway folder, never to a Cloud Storage bucket.
os.environ.pop("AADHAR_PHOTO_BUCKET", None)
_photo_dir = tempfile.mkdtemp(prefix="mes-test-photos-")
os.environ["AADHAR_PHOTO_DIR"] = _photo_dir
atexit.register(shutil.rmtree, _photo_dir, ignore_errors=True)

_database_url = os.getenv("DATABASE_URL", "")
_database_name = make_url(_database_url).database if _database_url else None
if not _database_name or not _database_name.endswith("_test"):
    pytest.exit(
        f"Refusing to run tests against database {_database_name!r}: "
        "point DATABASE_URL at a database whose name ends in _test.",
        returncode=2,
    )
