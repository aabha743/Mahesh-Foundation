-- ============================================
-- Add lease_extensions.requested_due_date
--
-- The API used to add this column itself, on the first extension request
-- after a restart. Production and db/schema.sql already have it, so this
-- is a no-op there; it exists so the code no longer changes the schema.
-- ============================================

ALTER TABLE lease_extensions
  ADD COLUMN IF NOT EXISTS requested_due_date DATE NULL;
