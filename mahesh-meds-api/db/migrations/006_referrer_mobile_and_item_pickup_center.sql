-- ============================================
-- Referrer's mobile number, and a pickup center for each requested device
--
-- reference_mobile: the referrer's number, asked for on the request form so the
-- referrer can be told about requests that name them.
-- lease_items.pickup_center_id: the center the requester chose to collect that
-- device from (devices can be at different centers). Stock is held there.
-- Requests made before this have neither, so both allow NULL.
-- Running it again changes nothing.
-- ============================================

ALTER TABLE lease_requests
  ADD COLUMN IF NOT EXISTS reference_mobile VARCHAR(15) NULL AFTER reference_name;

ALTER TABLE lease_requests
  ADD CONSTRAINT IF NOT EXISTS chk_lease_reference_mobile_10_digits
  CHECK (reference_mobile IS NULL OR reference_mobile REGEXP '^[0-9]{10}$');

ALTER TABLE lease_items
  ADD COLUMN IF NOT EXISTS pickup_center_id CHAR(36) NULL AFTER asset_id;

ALTER TABLE lease_items
  ADD CONSTRAINT fk_items_pickup_center FOREIGN KEY IF NOT EXISTS (pickup_center_id)
  REFERENCES centers(id) ON DELETE SET NULL;
