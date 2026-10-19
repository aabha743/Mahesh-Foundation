-- ============================================
-- Aadhaar number and card photo for the requester and the patient
--
-- New requests carry the patient's Aadhaar number, a photo of each Aadhaar
-- card and the time the requester consented to storing them. The photos are
-- kept in a private Cloud Storage bucket; these columns hold their object
-- names. A retention job removes the photos (not the numbers) some days after
-- a request is finished and records when in aadhar_photos_deleted_at.
-- Requests made before this have none of these, so the columns allow NULL.
-- Running it again changes nothing.
-- ============================================

ALTER TABLE lease_requests
  ADD COLUMN IF NOT EXISTS patient_aadhar_number VARCHAR(20) NULL AFTER patient_name,
  ADD COLUMN IF NOT EXISTS aadhar_photo VARCHAR(255) NULL AFTER patient_aadhar_number,
  ADD COLUMN IF NOT EXISTS patient_aadhar_photo VARCHAR(255) NULL AFTER aadhar_photo,
  ADD COLUMN IF NOT EXISTS aadhar_consent_at DATETIME NULL AFTER patient_aadhar_photo,
  ADD COLUMN IF NOT EXISTS aadhar_photos_deleted_at DATETIME NULL AFTER aadhar_consent_at;

ALTER TABLE lease_requests
  ADD CONSTRAINT IF NOT EXISTS chk_lease_patient_aadhar_12_digits
  CHECK (patient_aadhar_number IS NULL OR patient_aadhar_number REGEXP '^[0-9]{12}$');
