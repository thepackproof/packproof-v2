-- Surface declares feature availability; it does not attest hardware or camera origin.
-- Existing pinned identifier policies remain immutable and unchanged.
ALTER TABLE capture_sessions DROP CONSTRAINT capture_identifier_policy_valid;
ALTER TABLE capture_sessions ADD CONSTRAINT capture_identifier_policy_valid CHECK(identifier_policy IS NULL OR
 (identifier_policy->>'version'='1' AND identifier_policy->>'surface' IN ('ANDROID','IOS','WEB','WAREHOUSE')));

-- Keep iOS study timings distinct from Android without changing historic events.
ALTER TABLE program_timing_events DROP CONSTRAINT program_timing_events_device_class_check;
ALTER TABLE program_timing_events ADD CONSTRAINT program_timing_events_device_class_check
 CHECK(device_class IN ('s24_ultra','a16_5g','other_android','ios','web','unknown'));
