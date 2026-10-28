import os
import unittest
import uuid
from datetime import timedelta
from types import SimpleNamespace
from unittest import mock

import httpx
from sqlalchemy import func

from app.database import SessionLocal
from app.jobs import sms_delivery
from app.models import NotificationLog
from app.services import sms

EVENT = "test_sms_delivery"
MOBILE = "919000000001"
# Replies as BulkSMS sends them (seen 2026-10-28 for a delivered message and one DLT blocked), with the empty
# ASP.NET page that follows the answer.
PAGE = '\r\n\r\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN">\r\n<html><body><form></form></body></html>'
DELIVERED = f"{MOBILE}-DELIVRD ;{PAGE}"
AWAITED = f"{MOBILE}-AWAITED-DLR ;{PAGE}"
UNDELIVERED = f"{MOBILE}-UNDELIV ;{PAGE}"
BAD_KEY = f"TRACE:107! Not Valid API KEY{PAGE}"


def reply(text: str, status_code: int = 200):
    return SimpleNamespace(status_code=status_code, text=text)


class DeliveryReplyTests(unittest.TestCase):
    def test_reads_the_status_code_after_the_number(self):
        self.assertEqual(sms.parse_delivery_reply(DELIVERED), ("delivered", "DELIVRD"))
        self.assertEqual(sms.parse_delivery_reply(AWAITED), ("pending", "AWAITED-DLR"))
        self.assertEqual(sms.parse_delivery_reply(UNDELIVERED), ("failed", "UNDELIV"))
        self.assertEqual(sms.parse_delivery_reply(f"{MOBILE}-delivrd"), ("delivered", "DELIVRD"))

    def test_a_refused_lookup_is_an_error_not_a_status(self):
        with self.assertRaisesRegex(sms.DeliveryLookupError, "TRACE:107! Not Valid API KEY"):
            sms.parse_delivery_reply(BAD_KEY)

    def test_an_unrecognised_reply_is_kept_without_phone_numbers(self):
        self.assertEqual(
            sms.parse_delivery_reply(f"No record for\r\n {MOBILE}{PAGE}"),
            ("unrecognised", "No record for <number>"),
        )

    def test_asks_by_message_id_and_reports_an_unreachable_provider(self):
        with mock.patch.object(sms.httpx, "get", return_value=reply(DELIVERED)) as get:
            self.assertEqual(sms.fetch_delivery_status("330073410"), ("delivered", "DELIVRD"))
        self.assertEqual(get.call_args.args, (sms.SMS_STATUS_URL,))
        self.assertEqual(get.call_args.kwargs["params"]["messageid"], "330073410")

        with mock.patch.object(sms.httpx, "get", side_effect=httpx.ConnectError("refused")):
            with self.assertRaisesRegex(sms.DeliveryLookupError, "not reachable"):
                sms.fetch_delivery_status("1")
        with mock.patch.object(sms.httpx, "get", return_value=reply("", status_code=503)):
            with self.assertRaisesRegex(sms.DeliveryLookupError, "HTTP 503"):
                sms.fetch_delivery_status("1")


class DeliveryTestCase(unittest.TestCase):
    def setUp(self):
        self.db = SessionLocal()
        self.now = self.db.query(func.now()).scalar()

    def tearDown(self):
        self.db.rollback()
        self.db.query(NotificationLog).filter(NotificationLog.type == EVENT).delete()
        self.db.commit()
        self.db.close()

    def reload(self, row_id: str) -> NotificationLog:
        self.db.commit()  # end the read snapshot so the job's commits are visible
        return self.db.get(NotificationLog, row_id, populate_existing=True)


class SendKeepsMessageIdTests(DeliveryTestCase):
    def send(self, provider_reply: str) -> NotificationLog:
        with mock.patch.dict(os.environ, {"SMS_ENABLED": "true"}), \
                mock.patch.object(sms, "SMS_API_KEY", "test-key"), \
                mock.patch.object(sms, "SMS_USERNAME", "test-user"), \
                mock.patch.object(sms.httpx, "get", return_value=reply(provider_reply)):
            sms.send_sms(MOBILE, "test message", "1207164430243674445", self.db, event_name=EVENT)
        return self.db.query(NotificationLog).filter(NotificationLog.type == EVENT).one()

    def test_an_accepted_message_is_pending_with_its_message_id(self):
        row = self.send(f"MessageId-330073410{PAGE}")
        self.assertEqual((row.status, row.provider_message_id, row.delivery_status), ("sent", "330073410", "pending"))

    def test_a_refused_message_has_nothing_to_check(self):
        row = self.send("Invalid Template")
        self.assertEqual((row.status, row.provider_message_id, row.delivery_status), ("failed", None, None))


class DeliveryJobTests(DeliveryTestCase):
    def add(self, sent_ago: timedelta, checked_ago: timedelta | None = None) -> NotificationLog:
        row = NotificationLog(
            recipient_mobile=MOBILE,
            message="test message",
            type=EVENT,
            status="sent",
            provider_message_id=str(uuid.uuid4().int)[:12],
            delivery_status="pending",
            delivery_checked_at=None if checked_ago is None else self.now - checked_ago,
            sent_at=self.now - sent_ago,
        )
        self.db.add(row)
        self.db.commit()
        return row

    def run_job(self, replies: dict[str, str]):
        """Runs the job with BulkSMS answering replies[message_id]; returns (checked, message ids asked about)."""
        asked = []

        def bulksms(url, params, timeout):
            asked.append(params["messageid"])
            return reply(replies.get(params["messageid"], AWAITED))

        with mock.patch.dict(os.environ, {"SMS_ENABLED": "true"}), \
                mock.patch.object(sms, "SMS_API_KEY", "test-key"), \
                mock.patch.object(sms.httpx, "get", side_effect=bulksms):
            checked = sms_delivery.check_sms_delivery()
        return checked, asked

    def test_records_delivered_failed_and_no_report(self):
        delivered = self.add(timedelta(minutes=5))
        failed = self.add(timedelta(minutes=5))
        waiting = self.add(timedelta(hours=3))
        given_up = self.add(timedelta(hours=49), checked_ago=timedelta(hours=7))
        too_new = self.add(timedelta(seconds=30))
        ids = {row.id: row.provider_message_id for row in (delivered, failed, waiting, given_up, too_new)}

        with self.assertLogs("app.jobs.sms_delivery", level="WARNING") as logs:
            _, asked = self.run_job({ids[delivered.id]: DELIVERED, ids[failed.id]: UNDELIVERED})

        self.assertNotIn(ids[too_new.id], asked)
        outcome = {row_id: self.reload(row_id) for row_id in ids}
        self.assertEqual((outcome[delivered.id].delivery_status, outcome[delivered.id].delivery_detail), ("delivered", "DELIVRD"))
        self.assertEqual((outcome[failed.id].delivery_status, outcome[failed.id].delivery_detail), ("failed", "UNDELIV"))
        self.assertEqual((outcome[waiting.id].delivery_status, outcome[waiting.id].delivery_detail), ("pending", "AWAITED-DLR"))
        self.assertIsNotNone(outcome[waiting.id].delivery_checked_at)
        self.assertEqual((outcome[given_up.id].delivery_status, outcome[given_up.id].delivery_detail), ("no_report", "AWAITED-DLR"))
        self.assertEqual((outcome[too_new.id].delivery_status, outcome[too_new.id].delivery_checked_at), ("pending", None))

        warned = "\n".join(logs.output)
        self.assertIn(failed.id, warned)
        self.assertIn(given_up.id, warned)
        self.assertNotIn(delivered.id, warned)
        self.assertNotIn(MOBILE, warned)

    def test_older_messages_are_asked_about_less_often(self):
        recently_asked = self.add(timedelta(hours=3), checked_ago=timedelta(minutes=20))
        asked_long_ago = self.add(timedelta(hours=3), checked_ago=timedelta(minutes=70))

        _, asked = self.run_job({})

        self.assertNotIn(recently_asked.provider_message_id, asked)
        self.assertIn(asked_long_ago.provider_message_id, asked)

    def test_at_most_the_run_limit_never_asked_first(self):
        asked_before = self.add(timedelta(hours=8), checked_ago=timedelta(hours=7))
        first = self.add(timedelta(minutes=30))
        second = self.add(timedelta(minutes=20))

        with mock.patch.object(sms_delivery, "MAX_CHECKS_PER_RUN", 2):
            checked, asked = self.run_job({})

        mine = [message_id for message_id in asked if message_id in {
            asked_before.provider_message_id, first.provider_message_id, second.provider_message_id}]
        self.assertEqual(checked, 2)
        self.assertEqual(mine, [first.provider_message_id, second.provider_message_id])

    def test_a_refused_lookup_stops_the_run_and_leaves_messages_pending(self):
        first = self.add(timedelta(minutes=10))
        second = self.add(timedelta(minutes=5))

        with self.assertLogs("app.jobs.sms_delivery", level="WARNING") as logs:
            with mock.patch.dict(os.environ, {"SMS_ENABLED": "true"}), \
                    mock.patch.object(sms, "SMS_API_KEY", "test-key"), \
                    mock.patch.object(sms.httpx, "get", return_value=reply(BAD_KEY)) as get:
                checked = sms_delivery.check_sms_delivery()

        self.assertEqual((checked, get.call_count), (0, 1))
        self.assertIn("TRACE:107", "\n".join(logs.output))
        for row_id in (first.id, second.id):
            row = self.reload(row_id)
            self.assertEqual((row.delivery_status, row.delivery_checked_at), ("pending", None))

    def test_nothing_is_asked_while_sms_is_off(self):
        self.add(timedelta(minutes=10))
        with mock.patch.object(sms.httpx, "get", side_effect=AssertionError("provider must not be called")):
            self.assertEqual(sms_delivery.check_sms_delivery(), 0)


if __name__ == "__main__":
    unittest.main()
