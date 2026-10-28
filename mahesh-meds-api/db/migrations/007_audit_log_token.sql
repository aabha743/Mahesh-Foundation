-- ============================================
-- The request token on each activity-log entry, in its own indexed column
--
-- A request's timeline asks for that token's entries. The token used to be read out of the
-- old/new values after taking the newest entries of the whole log, so once enough newer
-- entries existed, older requests lost the start of their history. With the column, the
-- database returns exactly that token's entries at any log size.
-- The application fills it on every new entry; this fills it for the entries already there.
-- Running it again changes nothing.
-- ============================================

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS token VARCHAR(20) NULL AFTER entity_id;

CREATE INDEX IF NOT EXISTS idx_audit_token ON audit_log (token, created_at);

UPDATE audit_log
  SET token = LEFT(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(new_value, '$.token')),
                            JSON_UNQUOTE(JSON_EXTRACT(old_value, '$.token'))), 20)
  WHERE token IS NULL
    AND COALESCE(JSON_EXTRACT(new_value, '$.token'), JSON_EXTRACT(old_value, '$.token')) IS NOT NULL
    AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(new_value, '$.token')),
                 JSON_UNQUOTE(JSON_EXTRACT(old_value, '$.token'))) <> 'null';
