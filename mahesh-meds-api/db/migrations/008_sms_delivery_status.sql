-- ============================================
-- Whether each SMS reached the phone, not just whether BulkSMS accepted it
--
-- provider_message_id: the n of the "MessageId-<n>" BulkSMS answers when it accepts a message.
-- delivery_status: pending (accepted, no final report yet), delivered, failed (the operator reported a failure,
-- e.g. UNDELIV), no_report (still no final report 48 hours after sending; in practice not delivered).
-- NULL for messages BulkSMS never accepted and for rows logged before this change.
-- delivery_detail: the status BulkSMS reported, e.g. DELIVRD, AWAITED-DLR, UNDELIV.
-- delivery_checked_at: when the scheduled job last asked BulkSMS (app/jobs/sms_delivery.py).
-- status keeps its meaning (sent = accepted by BulkSMS). Running it again changes nothing.
-- ============================================

ALTER TABLE notifications_log
  ADD COLUMN IF NOT EXISTS provider_message_id VARCHAR(40) NULL AFTER error_message,
  ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(20) NULL AFTER provider_message_id,
  ADD COLUMN IF NOT EXISTS delivery_detail VARCHAR(255) NULL AFTER delivery_status,
  ADD COLUMN IF NOT EXISTS delivery_checked_at DATETIME NULL AFTER delivery_detail;

CREATE INDEX IF NOT EXISTS idx_notif_delivery ON notifications_log (delivery_status, sent_at);
