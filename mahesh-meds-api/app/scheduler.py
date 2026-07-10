import logging
import os

# pyrefly: ignore [missing-import]
from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
# pyrefly: ignore [missing-import]
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.database import DATABASE_URL, engine

from app.jobs.reminders import send_due_date_reminders, release_expired_blocks

logger = logging.getLogger(__name__)

SCHEDULER_LOCK_NAME = "mahesh_meds_scheduler"
_scheduler_lock_connection: Connection | None = None
_scheduler_is_leader = False

jobstores = {
    "default": SQLAlchemyJobStore(url=os.getenv("DATABASE_URL", DATABASE_URL))
}

scheduler = AsyncIOScheduler(jobstores=jobstores, timezone="Asia/Kolkata")


def try_acquire_scheduler_lock() -> bool:
    global _scheduler_lock_connection, _scheduler_is_leader

    if _scheduler_is_leader and _scheduler_lock_connection is not None:
        return True

    if engine.dialect.name != "mysql":
        logger.warning("Scheduler startup skipped: advisory lock is only configured for MySQL")
        return False

    connection: Connection | None = None
    try:
        connection = engine.connect()
        acquired = connection.execute(
            text("SELECT GET_LOCK(:lock_name, 0)"),
            {"lock_name": SCHEDULER_LOCK_NAME},
        ).scalar()
        if acquired == 1:
            _scheduler_lock_connection = connection
            _scheduler_is_leader = True
            logger.info("This process acquired the scheduler advisory lock")
            return True
        logger.info("Scheduler not started in this process because another worker holds the leader lock")
        connection.close()
        return False
    except Exception:
        logger.exception("Scheduler startup skipped because advisory lock acquisition failed")
        if connection is not None:
            connection.close()
        return False


def release_scheduler_lock() -> None:
    global _scheduler_lock_connection, _scheduler_is_leader

    if not _scheduler_is_leader or _scheduler_lock_connection is None:
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
