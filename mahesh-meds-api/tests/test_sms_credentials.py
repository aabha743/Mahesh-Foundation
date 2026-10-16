import os
import unittest
from unittest import mock

from app.database import SessionLocal
from app.models import NotificationLog
from app.services import sms

EVENT = "test_missing_sms_credentials"


class SMSCredentialTests(unittest.TestCase):
    """Credentials come only from the environment; without them nothing is sent."""

    def setUp(self):
        self.db = SessionLocal()

    def tearDown(self):
        self.db.query(NotificationLog).filter(NotificationLog.type == EVENT).delete()
        self.db.commit()
        self.db.close()

    def test_enabled_sms_without_credentials_never_calls_the_provider(self):
        with mock.patch.dict(os.environ, {"SMS_ENABLED": "true"}), \
                mock.patch.object(sms, "SMS_API_KEY", ""), \
                mock.patch.object(sms.httpx, "get", side_effect=AssertionError("provider must not be called")):
            sent = sms.send_sms("9000000099", "test message", "1207164430243674445", self.db, event_name=EVENT)

        self.assertFalse(sent)
        row = self.db.query(NotificationLog).filter(NotificationLog.type == EVENT).one()
        self.assertEqual((row.status, row.error_message), ("failed", "SMS_API_KEY / SMS_USERNAME not configured"))


if __name__ == "__main__":
    unittest.main()
