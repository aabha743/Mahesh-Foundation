import tempfile
import unittest
import uuid
from pathlib import Path

from sqlalchemy import text

from app.database import engine
from app.migrate import MIGRATIONS_DIR, apply_pending, applied, mark_applied, pending, statements


class StatementSplitTests(unittest.TestCase):
    def test_comments_are_dropped_and_semicolons_end_statements(self):
        sql = (
            "-- header\n"
            "ALTER TABLE a\n"
            "  ADD COLUMN b INT; \n"
            "\n"
            "-- second\n"
            "UPDATE a SET b = 1 WHERE c = 'x;y'\n"
            "  AND d = 2;\n"
            "SELECT 1\n"
        )
        self.assertEqual(statements(sql), [
            "ALTER TABLE a\n  ADD COLUMN b INT",
            "UPDATE a SET b = 1 WHERE c = 'x;y'\n  AND d = 2",
            "SELECT 1",
        ])


class MigrationRunnerTests(unittest.TestCase):
    """Runs against the *_test database (see conftest.py)."""

    def setUp(self):
        self.suffix = uuid.uuid4().hex[:8]
        self.table = f"migrate_test_{self.suffix}"
        self.dir = Path(tempfile.mkdtemp())
        self.names = [f"900_{self.suffix}_create.sql", f"901_{self.suffix}_add_column.sql"]
        (self.dir / self.names[0]).write_text(
            f"-- creates a scratch table\nCREATE TABLE IF NOT EXISTS {self.table} (id INT PRIMARY KEY);\n", encoding="utf-8")
        (self.dir / self.names[1]).write_text(
            f"ALTER TABLE {self.table}\n  ADD COLUMN IF NOT EXISTS note VARCHAR(20) NULL;\n", encoding="utf-8")

    def tearDown(self):
        with engine.begin() as conn:
            conn.execute(text(f"DROP TABLE IF EXISTS {self.table}"))
            for name in self.names:
                conn.execute(text("DELETE FROM schema_migrations WHERE name = :name"), {"name": name})

    def test_applies_pending_migrations_once_in_order(self):
        self.assertEqual([path.name for path in pending(engine, self.dir)], self.names)

        first = apply_pending(engine, self.dir, log=lambda _: None)
        again = apply_pending(engine, self.dir, log=lambda _: None)

        self.assertEqual((first, again), (self.names, []))
        self.assertTrue(set(self.names) <= set(applied(engine)))
        with engine.connect() as conn:
            columns = {row[0] for row in conn.execute(text(f"SHOW COLUMNS FROM {self.table}"))}
        self.assertEqual(columns, {"id", "note"})

    def test_mark_applied_records_without_running(self):
        self.assertTrue(mark_applied(engine, self.names[0], self.dir))
        self.assertFalse(mark_applied(engine, self.names[0], self.dir))

        self.assertEqual([path.name for path in pending(engine, self.dir)], self.names[1:])
        with engine.connect() as conn:
            exists = conn.execute(text("SHOW TABLES LIKE :t"), {"t": self.table}).first()
        self.assertIsNone(exists)

    def test_mark_applied_rejects_unknown_file(self):
        with self.assertRaises(ValueError):
            mark_applied(engine, "999_does_not_exist.sql", self.dir)

    def test_repository_migrations_are_safe_to_run_on_the_current_schema(self):
        # The test database is built from db/schema.sql, which already contains every migration.
        apply_pending(engine, MIGRATIONS_DIR, log=lambda _: None)

        self.assertEqual(pending(engine, MIGRATIONS_DIR), [])


if __name__ == "__main__":
    unittest.main()
