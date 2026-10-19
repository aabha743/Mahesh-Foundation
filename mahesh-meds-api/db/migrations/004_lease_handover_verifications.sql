-- ============================================
-- OTP before a device is handed over
--
-- Before devices are issued against a request, the person collecting them reads
-- out an OTP sent to the request's mobile number. Each accepted OTP adds a row
-- here: it lets the staff member who entered it issue devices for that request
-- once, until expires_at. used_at is set by the save that issued the devices.
-- Running it again changes nothing.
-- ============================================

CREATE TABLE IF NOT EXISTS lease_handover_verifications (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  lease_request_id CHAR(36) NOT NULL,
  center_id CHAR(36),
  verified_by CHAR(36),
  verified_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  FOREIGN KEY (lease_request_id) REFERENCES lease_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (center_id) REFERENCES centers(id) ON DELETE SET NULL,
  FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_handover_request_user (lease_request_id, verified_by)
);
