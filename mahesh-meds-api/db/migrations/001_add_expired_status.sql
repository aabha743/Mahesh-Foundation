-- ============================================
-- Add 'expired' to lease_requests.status
-- 2026-10-16
--
-- An approved request whose reserved stock was not collected within
-- PICKUP_WINDOW_HOURS is marked 'expired' by the release_expired_blocks job.
--
-- Appending an ENUM value is an instant metadata change in MariaDB;
-- ALGORITHM=INSTANT makes the statement fail instead of rebuilding the
-- table if that ever stops being true.
--
-- Applied by hand in production on 2026-10-16, before migrations were tracked;
-- see README.md in this folder for how migrations are applied now.
-- ============================================

ALTER TABLE lease_requests
  MODIFY status ENUM(
    'pending',
    'approved',
    'rejected',
    'issued',
    'returned',
    'partially_returned',
    'expired'
  ) NOT NULL DEFAULT 'pending',
  ALGORITHM=INSTANT;
