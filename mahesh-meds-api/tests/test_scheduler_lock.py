import time
import unittest
from unittest.mock import patch

from sqlalchemy import text

from app import scheduler as s
from app.database import engine


def lock_owner() -> int | None:
    """The connection id holding the scheduler lock, asked from a separate connection."""
    with engine.connect() as other:
        return other.execute(text("SELECT IS_USED_LOCK(:n)"), {"n": s.SCHEDULER_LOCK_NAME}).scalar()


def connection_id(connection) -> int:
    return connection.execute(text("SELECT CONNECTION_ID()")).scalar()


class SchedulerLockTests(unittest.TestCase):
    """Runs against the *_test database (see conftest.py); no test here starts the scheduler itself."""

    def setUp(self):
        self.assertIsNone(lock_owner(), "another process holds the scheduler lock on the test database")
        self.assertTrue(s.try_acquire_scheduler_lock())
        self.lock_id = connection_id(s._scheduler_lock_connection)

    def tearDown(self):
        s.release_scheduler_lock()
        self.assertIsNone(lock_owner())

    def kill_lock_connection(self):
        """What MariaDB does to a connection idle for wait_timeout: closes it, which releases the lock."""
        with engine.connect() as other:
            other.execute(text(f"KILL CONNECTION {self.lock_id}"))
        for _ in range(50):
            if lock_owner() is None:
                return
            time.sleep(0.1)
        self.fail("the lock outlived its connection")

    def test_the_lock_connection_never_idles_out(self):
        s._scheduler_lock_connection.execute(text("SET SESSION wait_timeout = 2"))
        for _ in range(4):  # 4 s in all, twice the idle timeout
            time.sleep(1)
            s.keep_scheduler_lock()
        self.assertEqual(lock_owner(), self.lock_id)

    def test_without_the_check_the_lock_is_lost_when_its_connection_idles_out(self):
        # The fault in production (wait_timeout 8 hours there): shows the test above is not passing by accident.
        s._scheduler_lock_connection.execute(text("SET SESSION wait_timeout = 1"))
        time.sleep(2.5)
        self.assertIsNone(lock_owner())

    def test_a_lost_lock_is_taken_again(self):
        self.kill_lock_connection()
        with self.assertLogs("app.scheduler", "INFO") as logs:
            s.keep_scheduler_lock()
        self.assertTrue(s._scheduler_is_leader)
        new_id = connection_id(s._scheduler_lock_connection)
        self.assertNotEqual(new_id, self.lock_id)
        self.assertEqual(lock_owner(), new_id)
        self.assertIn("took the scheduler advisory lock again", "\n".join(logs.output))

    def test_the_scheduler_stops_when_another_worker_took_the_lock(self):
        self.kill_lock_connection()
        with engine.connect() as other_worker:
            self.assertEqual(other_worker.execute(text("SELECT GET_LOCK(:n, 0)"), {"n": s.SCHEDULER_LOCK_NAME}).scalar(), 1)
            with patch.object(s, "stop_scheduler", wraps=s.stop_scheduler) as stop:
                s.keep_scheduler_lock()
            stop.assert_called_once()
            self.assertFalse(s._scheduler_is_leader)
            self.assertIsNone(s._scheduler_lock_connection)
            self.assertEqual(lock_owner(), connection_id(other_worker))
            other_worker.execute(text("SELECT RELEASE_LOCK(:n)"), {"n": s.SCHEDULER_LOCK_NAME})

    def test_while_the_database_is_down_it_tries_again_at_the_next_check(self):
        self.kill_lock_connection()
        with patch.object(s, "_take_lock", side_effect=ConnectionError("database down")):
            with self.assertLogs("app.scheduler", "ERROR"):
                s.keep_scheduler_lock()
        self.assertTrue(s._scheduler_is_leader)
        self.assertIsNone(s._scheduler_lock_connection)
        s.keep_scheduler_lock()  # the database is back
        self.assertEqual(lock_owner(), connection_id(s._scheduler_lock_connection))

    def test_the_check_is_a_scheduled_job(self):
        with patch.object(s.scheduler, "add_job") as add_job:
            s._register_jobs()
        jobs = {c.kwargs["id"]: c for c in add_job.call_args_list}
        self.assertIs(jobs["keep_scheduler_lock"].args[0], s.keep_scheduler_lock)
        self.assertEqual(jobs["keep_scheduler_lock"].kwargs["minutes"], s.SCHEDULER_LOCK_CHECK_MINUTES)
