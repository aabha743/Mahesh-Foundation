import os
from collections.abc import Generator

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, declarative_base, sessionmaker

# Load local .env values so DATABASE_URL works in dev.
load_dotenv()

DEBUG_MODE = os.getenv("DEBUG", "false").lower() in ("true", "1", "yes")
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    if DEBUG_MODE:
        DATABASE_URL = "mysql+pymysql://root:password@localhost:3306/mahesh_meds"
    else:
        raise RuntimeError("DATABASE_URL must be set when DEBUG=false")

# pool_pre_ping recovers stale connections after DB restarts or idle timeouts.
engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency that provides a DB session per request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
