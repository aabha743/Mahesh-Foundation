import logging
import os
import threading

# pyrefly: ignore [missing-import]
from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
# pyrefly: ignore [missing-import]
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.database import DATABASE_URL, engine

from app.jobs.aadhar_photos import delete_expired_aadhar_photos
from app.jobs.reminders import send_due_date_reminders, release_expired_blocks
from app.jobs.sms_delivery import check_sms_delivery

logger = logging.getLogger(__name__)

SCHEDULER_LOCK_NAME = "mahesh_meds_scheduler"
# The lock lasts as long as its database connection, and MariaDB closes a connection idle for wait_timeout
# (8 hours on the server). keep_scheduler_lock uses the connection this often so that never happens.
SCHEDULER_LOCK_CHECK_MINUTES = 5
_scheduler_lock_connection: Connection | None = None
_scheduler_is_leader = False
# keep_scheduler_lock runs in a job thread; shutdown releases the lock from another thread.
_scheduler_lock_guard = threading.Lock()

jobstores = {
    "default": SQLAlchemyJobStore(url=os.getenv("DATABASE_URL", DATABASE_URL))
}

scheduler = AsyncIOScheduler(jobstores=jobstores, timezone="Asia/Kolkata")


def _take_lock() -> Connection | None:
    """A new connection holding the lock, or None when another worker holds it. Raises when the database fails."""
    connection = engine.connect()
    try:
        acquired = connection.execute(
            text("SELECT GET_LOCK(:lock_name, 0)"),
            {"lock_name": SCHEDULER_LOCK_NAME},
        ).scalar()
    except Exception:
        connection.close()
        raise
    if acquired == 1:
        return connection
    connection.close()
    return None


def try_acquire_scheduler_lock() -> bool:
    global _scheduler_lock_connection, _scheduler_is_leader

    if _scheduler_is_leader and _scheduler_lock_connection is not None:
        return True

    if engine.dialect.name != "mysql":
        logger.warning("Scheduler startup skipped: advisory lock is only configured for MySQL")
        return False

    try:
        connection = _take_lock()
    except Exception:
        logger.exception("Scheduler startup skipped because advisory lock acquisition failed")
        return False
    if connection is None:
        logger.info("Scheduler not started in this process because another worker holds the leader lock")
        return False
    _scheduler_lock_connection = connection
    _scheduler_is_leader = True
    logger.info("This process acquired the scheduler advisory lock")
    return True


def keep_scheduler_lock() -> None:
    """Runs every few minutes in the process that holds the lock, so its connection never sits idle.

    If the connection was lost anyway (MariaDB restarted, say), the lock went with it: take it again on a new
    connection, or try again at the next run while the database is down. If another worker took the lock in
    between, stop the scheduler here, so no job runs twice.
    """
    global _scheduler_lock_connection

    with _scheduler_lock_guard:
        if not _scheduler_is_leader:
            return
        if _scheduler_lock_connection is not None:
            try:
                held = _scheduler_lock_connection.execute(
                    text("SELECT IS_USED_LOCK(:lock_name) = CONNECTION_ID()"),
                    {"lock_name": SCHEDULER_LOCK_NAME},
                ).scalar()
            except Exception:
                held = None
            if held == 1:
                return
            logger.warning("Scheduler advisory lock was lost with its database connection; taking it again")
            _scheduler_lock_connection.close()
            _scheduler_lock_connection = None
        try:
            _scheduler_lock_connection = _take_lock()
        except Exception:
            logger.exception("Could not take the scheduler advisory lock again; trying at the next check")
            return
        if _scheduler_lock_connection is not None:
            logger.info("This process took the scheduler advisory lock again")
            return
    logger.error("Another worker holds the scheduler advisory lock now; stopping the scheduler in this process")
    stop_scheduler()


def release_scheduler_lock() -> None:
    global _scheduler_lock_connection, _scheduler_is_leader

    with _scheduler_lock_guard:
        if not _scheduler_is_leader:
            return
        if _scheduler_lock_connection is None:  # lost, and not taken again (see keep_scheduler_lock)
            _scheduler_is_leader = False
            return

        try:
            _scheduler_lock_connection.execute(
                text("SELECT RELEASE_LOCK(:lock_name)"),
                {"lock_name": SCHEDULER_LOCK_NAME},
            )
            logger.info("Released scheduler advisory lock")
        except Exception:
            logger.exception("Failed while releasing scheduler advisory lock")
        finally:
            _scheduler_lock_connection.close()
            _scheduler_lock_connection = None
            _scheduler_is_leader = False


def _register_jobs() -> None:
    scheduler.add_job(
        keep_scheduler_lock,
        "interval",
        minutes=SCHEDULER_LOCK_CHECK_MINUTES,
        id="keep_scheduler_lock",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )
    scheduler.add_job(
        send_due_date_reminders,
        "cron",
        hour=9,
        minute=0,
        id="due_date_reminders",
        misfire_grace_time=3600,
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )
    scheduler.add_job(
        release_expired_blocks,
        "interval",
        minutes=30,
        id="release_expired_blocks",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )
    # Asks BulkSMS whether accepted SMS reached the phone; does nothing while SMS is off.
    scheduler.add_job(
        check_sms_delivery,
        "interval",
        minutes=10,
        id="check_sms_delivery",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )
    # Does nothing until AADHAR_PHOTO_RETENTION_DAYS is set.
    scheduler.add_job(
        delete_expired_aadhar_photos,
        "cron",
        hour=3,
        minute=30,
        id="delete_expired_aadhar_photos",
        misfire_grace_time=3600,
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )


def start_scheduler() -> None:
    if not try_acquire_scheduler_lock():
        return

    try:
        _register_jobs()
        if not scheduler.running:
            scheduler.start()
            logger.info("APScheduler started with persistent job store")
    except Exception:
        logger.exception("Scheduler startup failed after acquiring the leader lock")
        release_scheduler_lock()


def stop_scheduler() -> None:
    try:
        if scheduler.running:
            scheduler.shutdown(wait=False)
            logger.info("APScheduler stopped")
    finally:
        release_scheduler_lock()
