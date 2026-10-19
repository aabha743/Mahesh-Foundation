-- ============================================
-- Token counter, and no OTP codes in the SMS log
--
-- lease_token_seq numbers new requests: tokens look like MF-AUG-0001 and the
-- number never resets. NOCACHE keeps numbers consecutive across restarts.
--
-- OTP SMS used to be logged with the code in clear text. The code now logs
-- them masked; this hides the code in rows logged before that. Running it
-- again changes nothing.
-- ============================================

CREATE SEQUENCE IF NOT EXISTS lease_token_seq START WITH 1 INCREMENT BY 1 MINVALUE 1 NOCACHE;

UPDATE notifications_log
  SET message = REGEXP_REPLACE(message, '[0-9]{6}', '******')
  WHERE type = 'otp_login' AND message REGEXP '[0-9]{6}';
