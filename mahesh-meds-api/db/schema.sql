-- ============================================
-- MAHESH FOUNDATION MEDICAL DEVICE SYSTEM
-- MySQL Schema — Vetted Final Version
-- April 2026
-- ============================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE DATABASE IF NOT EXISTS mahesh_meds
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE mahesh_meds;

-- ============================================
-- 1. CENTERS
-- ============================================
CREATE TABLE centers (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  name VARCHAR(150) NOT NULL,
  address TEXT,
  city VARCHAR(100),
  state VARCHAR(100),
  pin_code VARCHAR(10),
  contact_person VARCHAR(150),
  contact_phone VARCHAR(15),
  is_active BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- 2. USERS
-- ============================================
CREATE TABLE users (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  name VARCHAR(150) NOT NULL,
  mobile VARCHAR(15) UNIQUE NOT NULL,
  center_id CHAR(36),
  is_active BOOLEAN DEFAULT TRUE,
  last_login DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_users_mobile_10_digits CHECK (mobile REGEXP '^[0-9]{10}$'),
  FOREIGN KEY (center_id) REFERENCES centers(id) ON DELETE SET NULL
);

-- ============================================
-- 3. ROLES
-- ============================================
CREATE TABLE roles (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  name VARCHAR(50) UNIQUE NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- 4. PERMISSIONS
-- ============================================
CREATE TABLE permissions (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  action VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- 5. USER ROLES (JUNCTION)
-- ============================================
CREATE TABLE user_roles (
  user_id CHAR(36) NOT NULL,
  role_id CHAR(36) NOT NULL,
  PRIMARY KEY (user_id, role_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  INDEX idx_user_roles_role (role_id)
);

-- ============================================
-- 6. ROLE PERMISSIONS (JUNCTION)
-- ============================================
CREATE TABLE role_permissions (
  role_id CHAR(36) NOT NULL,
  permission_id CHAR(36) NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE,
  INDEX idx_role_permissions_permission (permission_id)
);

-- ============================================
-- 7. OTP SESSIONS
-- ============================================
CREATE TABLE otp_sessions (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  mobile VARCHAR(15) NOT NULL,
  otp_code VARCHAR(255) NOT NULL,
  purpose VARCHAR(50) NOT NULL DEFAULT 'login',
  expires_at DATETIME NOT NULL,
  is_used BOOLEAN DEFAULT FALSE,
  attempts INT DEFAULT 0,
  user_agent TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_otp_lookup (mobile, purpose, is_used, expires_at, created_at),
  INDEX idx_otp_expires (expires_at)
);

-- ============================================
-- 8. REFRESH TOKENS
-- ============================================
CREATE TABLE refresh_tokens (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  user_id CHAR(36) NOT NULL,
  token_hash VARCHAR(255) NOT NULL,
  token_prefix VARCHAR(8) NOT NULL,
  expires_at DATETIME NOT NULL,
  revoked BOOLEAN DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_refresh_user (user_id),
  INDEX idx_refresh_active_lookup (user_id, revoked, expires_at),
  INDEX idx_refresh_expires (expires_at),
  INDEX idx_refresh_prefix (token_prefix)
);

-- ============================================
-- 9. SKUS
-- ============================================
CREATE TABLE skus (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  name VARCHAR(150) NOT NULL,
  sku_code VARCHAR(50) UNIQUE NOT NULL,
  description TEXT,
  category VARCHAR(100),
  image_url TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- 10. ASSETS
-- ============================================
CREATE TABLE assets (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  sku_id CHAR(36) NOT NULL,
  serial_number VARCHAR(100) UNIQUE NOT NULL,
  center_id CHAR(36),
  home_center_id CHAR(36),
  status ENUM('available','leased','repair','retired','in_transit') NOT NULL DEFAULT 'available',
  purchase_date DATE,
  warranty_expiry DATE,
  invoice_number VARCHAR(100),
  invoice_url TEXT,
  qr_code TEXT,
  notes TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sku_id) REFERENCES skus(id) ON DELETE RESTRICT,
  FOREIGN KEY (center_id) REFERENCES centers(id) ON DELETE SET NULL,
  FOREIGN KEY (home_center_id) REFERENCES centers(id) ON DELETE SET NULL,
  INDEX idx_assets_center (center_id),
  INDEX idx_assets_home_center (home_center_id),
  INDEX idx_assets_sku (sku_id),
  INDEX idx_assets_status (status),
  INDEX idx_assets_active (is_active),
  INDEX idx_assets_serial (serial_number),
  INDEX idx_assets_warranty (warranty_expiry)
);

-- ============================================
-- 11. LEASE REQUESTS
-- ============================================
CREATE TABLE lease_requests (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  token_number VARCHAR(20) UNIQUE NOT NULL,
  requestor_name VARCHAR(150) NOT NULL,
  mobile VARCHAR(15) NOT NULL,
  aadhar_number VARCHAR(20) NOT NULL,
  reference_name VARCHAR(150),
  preferred_center_id CHAR(36),
  expected_duration VARCHAR(50),
  due_date DATE,
  notes TEXT,
  status ENUM(
    'pending',
    'approved',
    'rejected',
    'issued',
    'returned',
    'partially_returned'
  ) NOT NULL DEFAULT 'pending',
  approval_comments TEXT,
  rejection_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_lease_mobile_10_digits CHECK (mobile REGEXP '^[0-9]{10}$'),
  CONSTRAINT chk_lease_aadhar_12_digits CHECK (aadhar_number REGEXP '^[0-9]{12}$'),
  FOREIGN KEY (preferred_center_id) REFERENCES centers(id) ON DELETE SET NULL,
  INDEX idx_lease_token (token_number),
  INDEX idx_lease_mobile (mobile),
  INDEX idx_lease_status (status),
  INDEX idx_lease_created (created_at),
  INDEX idx_lease_preferred_center (preferred_center_id),
  INDEX idx_lease_due (due_date)
);

-- ============================================
-- 12. LEASE ITEMS
-- ============================================
CREATE TABLE lease_items (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  lease_request_id CHAR(36) NOT NULL,
  sku_id CHAR(36) NOT NULL,
  asset_id CHAR(36),
  quantity_requested INT NOT NULL DEFAULT 1,
  approved_quantity INT DEFAULT NULL,
  issued_at DATETIME NULL,
  issued_by CHAR(36),
  due_date DATE,
  returned_at DATETIME NULL,
  returned_to CHAR(36),
  return_center_id CHAR(36),
  condition_on_return TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_qty_requested CHECK (quantity_requested > 0),
  CONSTRAINT chk_qty_approved CHECK (approved_quantity IS NULL OR approved_quantity >= 0),
  FOREIGN KEY (lease_request_id) REFERENCES lease_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (sku_id) REFERENCES skus(id) ON DELETE RESTRICT,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL,
  FOREIGN KEY (issued_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (returned_to) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (return_center_id) REFERENCES centers(id) ON DELETE SET NULL,
  INDEX idx_items_request (lease_request_id),
  INDEX idx_items_asset (asset_id),
  INDEX idx_items_sku (sku_id),
  INDEX idx_items_due (due_date)
);

-- ============================================
-- 13. LEASE EXTENSIONS
-- ============================================
CREATE TABLE lease_extensions (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  lease_request_id CHAR(36) NOT NULL,
  token_number VARCHAR(20) NOT NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  requested_duration VARCHAR(50) NOT NULL,
  requested_days INT NOT NULL,
  requested_due_date DATE,
  reason TEXT,
  requestor_name VARCHAR(150) NOT NULL,
  mobile VARCHAR(15) NOT NULL,
  aadhar_number VARCHAR(20) NOT NULL,
  current_due_date DATE NOT NULL,
  approved_due_date DATE,
  approver_comments TEXT,
  rejection_reason TEXT,
  requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  reviewed_at DATETIME NULL,
  reviewed_by CHAR(36),
  CONSTRAINT chk_lease_extensions_mobile_10_digits CHECK (mobile REGEXP '^[0-9]{10}$'),
  CONSTRAINT chk_lease_extensions_aadhar_12_digits CHECK (aadhar_number REGEXP '^[0-9]{12}$'),
  FOREIGN KEY (lease_request_id) REFERENCES lease_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_lease_extensions_lease_request (lease_request_id),
  INDEX idx_lease_extensions_token (token_number),
  INDEX idx_lease_extensions_status (status),
  INDEX idx_lease_extensions_requested_at (requested_at),
  INDEX idx_lease_extensions_reviewed_by (reviewed_by)
);

-- ============================================
-- 14. REPAIRS
-- ============================================
CREATE TABLE repairs (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  asset_id CHAR(36) NOT NULL,
  reported_by CHAR(36),
  repair_center_name VARCHAR(150),
  sent_date DATE,
  expected_return_date DATE,
  actual_return_date DATE,
  status ENUM('sent','in_progress','completed') NOT NULL DEFAULT 'sent',
  notes TEXT,
  cost DECIMAL(10,2),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT,
  FOREIGN KEY (reported_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_repairs_asset (asset_id),
  INDEX idx_repairs_status (status)
);

-- ============================================
-- 15. NOTIFICATIONS LOG
-- ============================================
CREATE TABLE notifications_log (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  recipient_mobile VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  type VARCHAR(100) NULL,
  reference_id CHAR(36) NULL,
  status VARCHAR(20) NOT NULL,
  error_message TEXT,
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_notif_mobile (recipient_mobile),
  INDEX idx_notif_status (status),
  INDEX idx_notif_reference_type_day (reference_id, type, sent_at),
  INDEX idx_notif_mobile_type_day (recipient_mobile, type, sent_at)
);

-- ============================================
-- 16. SMS TEMPLATES
-- ============================================
CREATE TABLE sms_templates (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  event_name VARCHAR(100) UNIQUE NOT NULL,
  template_text TEXT NOT NULL,
  template_id VARCHAR(100) NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- 17. AUDIT LOG
-- ============================================
CREATE TABLE audit_log (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  user_id CHAR(36),
  center_id CHAR(36),
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id CHAR(36),
  old_value JSON,
  new_value JSON,
  ip_address VARCHAR(45),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (center_id) REFERENCES centers(id) ON DELETE SET NULL,
  INDEX idx_audit_user (user_id),
  INDEX idx_audit_center (center_id),
  INDEX idx_audit_entity (entity_type, entity_id),
  INDEX idx_audit_created (created_at)
);

-- ============================================
-- STOCK VIEW — used by landing, approver, center pages
-- ============================================
CREATE VIEW sku_stock_by_center AS
  SELECT
    sku_id,
    center_id,
    COUNT(*) AS available_count
  FROM assets
  WHERE status = 'available'
  GROUP BY sku_id, center_id;

-- ============================================
-- ESSENTIAL SEED DATA
-- Seeds one OTP-login-capable master admin user plus the RBAC graph.
-- Login remains mobile + OTP only; no password row is stored anywhere.
-- ============================================

-- Seed permissions
INSERT INTO permissions (id, action, description) VALUES
  (UUID(), 'users.manage', 'Create, update, and manage users'),
  (UUID(), 'roles.manage', 'Create and manage roles and permissions'),
  (UUID(), 'assets.create', 'Create new assets in the system'),
  (UUID(), 'assets.update', 'Update existing asset information'),
  (UUID(), 'skus.manage', 'Manage SKU catalog'),
  (UUID(), 'centers.manage', 'Manage centers and locations'),
  (UUID(), 'requests.approve', 'Approve lease requests'),
  (UUID(), 'requests.reject', 'Reject lease requests'),
  (UUID(), 'requests.edit', 'Edit lease requests'),
  (UUID(), 'devices.issue', 'Issue devices to patients'),
  (UUID(), 'devices.collect', 'Collect returned devices'),
  (UUID(), 'audit.view', 'View audit logs and activity');

-- Seed roles
INSERT INTO roles (id, name, description) VALUES
  (UUID(), 'master_admin', 'Full system access - all permissions'),
  (UUID(), 'asset_manager', 'Manages assets and SKU catalog'),
  (UUID(), 'center_manager', 'Manages center operations and device issue/return workflows'),
  (UUID(), 'approver', 'Reviews and approves/rejects lease requests');

-- Assign permissions to roles (using subquery joins)
-- master_admin: all permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = 'master_admin';

-- asset_manager: assets.create, assets.update, skus.manage
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'asset_manager' AND p.action IN ('assets.create', 'assets.update', 'skus.manage');

-- center_manager: assets.update, devices.issue, devices.collect
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'center_manager' AND p.action IN ('assets.update', 'devices.issue', 'devices.collect');

-- approver: requests.approve, requests.reject, requests.edit
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'approver' AND p.action IN ('requests.approve', 'requests.reject', 'requests.edit');

-- Create master admin user and assign role
-- Seeded login mobile: 9876500001
SET @admin_user_id = UUID();
INSERT INTO users (id, name, mobile, center_id, is_active) VALUES
  (@admin_user_id, 'System Admin', '9876500001', NULL, TRUE);

INSERT INTO user_roles (user_id, role_id)
SELECT @admin_user_id, id FROM roles WHERE name = 'master_admin';

-- Seed SMS templates
INSERT INTO sms_templates (id, event_name, template_text, template_id, is_active) VALUES
  (UUID(), 'otp_login', 'Your OTP for Registration or Login for Marwari Angels-an initiative of Mahesh Foundation is {otp}', '1207164430243674445', TRUE),
  (UUID(), 'request_submitted_user', 'Mahesh Foundation: Your request is received. Token: {token_number}. We will update you after review.', NULL, TRUE),
  (UUID(), 'request_submitted_approver', 'New device request received on Mahesh Foundation portal. Requestor:{requestor_name}. Device Requested: {items}. Please review in the system.- MHSFND', '1207178298810693025', TRUE),
  (UUID(), 'request_approved_user', 'Mahesh Foundation: Request {token_number} is approved. {pickup_guidance}', NULL, TRUE),
  (UUID(), 'request_approved_center_manager', 'Mahesh Foundation: Request {token_number} for {requestor_name} is approved for {center_name}. Please prepare for fulfillment.', NULL, TRUE),
  (UUID(), 'request_rejected_user', 'Mahesh Foundation: Request {token_number} was not approved. Please contact support for help.', NULL, TRUE),
  (UUID(), 'device_issued_user', 'Devices have been issued by Mahesh Foundation Medical Equipment services against Token: {token_number}. Items:{items}. -MHSFND', '1207178299880758060', TRUE),
  (UUID(), 'return_reminder_7d', 'Reminder: Devices for Token: {token_number} are due on {due_date}. Please arrange return. - MHSFND', NULL, TRUE),
  (UUID(), 'return_reminder_3d', 'Reminder: Devices for Token: {token_number} are due on {due_date}. Please arrange return. - MHSFND', NULL, TRUE),
  (UUID(), 'return_reminder_1d', 'Reminder: Devices for Token: {token_number} are due on {due_date}. Please arrange return. - MHSFND', NULL, TRUE);
