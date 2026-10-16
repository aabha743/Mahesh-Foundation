"""Apply the SQL files in db/migrations to the database, once each, in file-name order.

    python -m app.migrate status                 list migrations and whether each has been applied
    python -m app.migrate apply                  apply the pending ones
    python -m app.migrate mark-applied <file>    record one as applied without running it (it was applied by hand)

Run from mahesh-meds-api/ so DATABASE_URL is read from .env. Applied migrations are recorded in the
schema_migrations table. MariaDB commits schema changes immediately, so a migration that fails part-way
is not rolled back: write each one so it is safe to run again (IF NOT EXISTS and the like).
"""
import argparse
import pathlib
import sys

from sqlalchemy import Engine, text

MIGRATIONS_DIR = pathlib.Path(__file__).resolve().parent.parent / "db" / "migrations"

CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS schema_migrations (
  name VARCHAR(255) NOT NULL PRIMARY KEY,
  applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)
"""


def statements(sql: str) -> list[str]:
    """Split a migration into statements: '--' comment lines are dropped and a ';' ending a line ends a statement."""
    found: list[str] = []
    current: list[str] = []
    for line in sql.splitlines():
        if line.strip().startswith("--"):
            continue
        current.append(line)
        if line.rstrip().endswith(";"):
            statement = "\n".join(current).strip().rstrip(";").strip()
            if statement:
                found.append(statement)
            current = []
    tail = "\n".join(current).strip()
    if tail:
        found.append(tail)
    return found


def migration_files(directory: pathlib.Path = MIGRATIONS_DIR) -> list[pathlib.Path]:
    return sorted(directory.glob("*.sql"))


def applied(engine: Engine) -> dict[str, object]:
    with engine.begin() as conn:
        conn.execute(text(CREATE_TABLE))
        return {name: applied_at for name, applied_at in conn.execute(text("SELECT name, applied_at FROM schema_migrations"))}


def pending(engine: Engine, directory: pathlib.Path = MIGRATIONS_DIR) -> list[pathlib.Path]:
    done = applied(engine)
    return [path for path in migration_files(directory) if path.name not in done]


def apply_pending(engine: Engine, directory: pathlib.Path = MIGRATIONS_DIR, log=print) -> list[str]:
    """Apply every pending migration in order; stops at the first failure (which is raised)."""
    names = []
    for path in pending(engine, directory):
        log(f"applying {path.name}")
        with engine.begin() as conn:
            for statement in statements(path.read_text(encoding="utf-8")):
                # exec_driver_sql: run the SQL as written (text() would treat ':name' as a bind parameter).
                conn.exec_driver_sql(statement)
            conn.execute(text("INSERT INTO schema_migrations (name) VALUES (:name)"), {"name": path.name})
        names.append(path.name)
    return names


def mark_applied(engine: Engine, name: str, directory: pathlib.Path = MIGRATIONS_DIR) -> bool:
    """Record a migration as applied without running it; returns False if it was already recorded."""
    if not (directory / name).is_file():
        raise ValueError(f"no migration named {name} in {directory}")
    if name in applied(engine):
        return False
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO schema_migrations (name) VALUES (:name)"), {"name": name})
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.migrate", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="list migrations and whether each has been applied")
    sub.add_parser("apply", help="apply pending migrations")
    mark = sub.add_parser("mark-applied", help="record a migration as applied without running it")
    mark.add_argument("name", help="file name in db/migrations, e.g. 001_add_expired_status.sql")
    args = parser.parse_args(argv)

    from app.database import engine

    if args.command == "status":
        done = applied(engine)
        files = migration_files()
        for path in files:
            print(f"{'applied ' + str(done[path.name]) if path.name in done else 'PENDING':<28} {path.name}")
        for name in sorted(set(done) - {path.name for path in files}):
            print(f"{'applied ' + str(done[name]):<28} {name}  (file not found)")
        print(f"{sum(path.name not in done for path in files)} pending")
        return 0
    if args.command == "apply":
        names = apply_pending(engine)
        print(f"applied {len(names)} migration(s)" if names else "nothing to apply")
        return 0
    if args.command == "mark-applied":
        print("recorded" if mark_applied(engine, args.name) else "already recorded")
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
