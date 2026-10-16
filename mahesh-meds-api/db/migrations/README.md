# Database migrations

Each `.sql` file here is one change to the production schema. They are applied in file-name order,
once each, by the migration runner, which records what it has applied in the `schema_migrations` table.

```bash
python -m app.migrate status        # what is applied and what is pending
python -m app.migrate apply         # apply the pending ones (the deploy script does this after the backup)
python -m app.migrate mark-applied 001_add_expired_status.sql   # record one that was applied by hand
```

Run these from `mahesh-meds-api/`, so `DATABASE_URL` comes from `.env`.

## Writing a migration

- Name it with the next number: `003_short_description.sql`.
- Also update `db/schema.sql`, which is what a fresh database and CI start from.
- Make it safe to run twice (`IF NOT EXISTS`, `IF EXISTS`, `MODIFY` to the full definition). MariaDB commits
  schema changes immediately, so a migration that fails part-way is not rolled back, and CI runs every
  migration against a schema that already contains it.
- Make it work with the code that is already running. The deploy applies migrations before it restarts the
  API, so for a few seconds the old code runs against the new schema. Add first, remove in a later release.
- End each statement with `;` at the end of a line. Lines starting with `--` are comments.
