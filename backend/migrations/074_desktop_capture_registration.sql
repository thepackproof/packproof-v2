-- Additive desktop provenance. Historic sessions and frozen manifests are untouched.
SET lock_timeout = '5s';
ALTER TABLE capture_sessions DROP CONSTRAINT capture_sessions_client_check;
ALTER TABLE capture_sessions ADD CONSTRAINT capture_sessions_client_check
  CHECK (client IN ('WEB_CAMERA','NATIVE_CAMERA','DESKTOP_CAMERA'));
ALTER TABLE capture_sessions ADD COLUMN desktop_context JSONB;
ALTER TABLE capture_sessions ADD CONSTRAINT desktop_capture_context_valid CHECK (
  (client = 'DESKTOP_CAMERA' AND desktop_context IS NOT NULL
    AND desktop_context->>'schemaVersion' = '1'
    AND desktop_context->>'platform' IN ('win32','darwin')
    AND policy_version = 'packproof.desktop-client-capture/v1' AND stage_id IS NULL)
  OR (client <> 'DESKTOP_CAMERA' AND desktop_context IS NULL)
);
ALTER TABLE capture_sessions DROP CONSTRAINT capture_identifier_policy_valid;
ALTER TABLE capture_sessions ADD CONSTRAINT capture_identifier_policy_valid CHECK(identifier_policy IS NULL OR
 (identifier_policy->>'version'='1' AND identifier_policy->>'surface' IN ('ANDROID','IOS','WEB','WAREHOUSE','DESKTOP')));
CREATE FUNCTION protect_desktop_capture_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.desktop_context IS DISTINCT FROM NEW.desktop_context THEN
    RAISE EXCEPTION 'DESKTOP_CAPTURE_CONTEXT_IMMUTABLE';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER desktop_capture_context_guard BEFORE UPDATE ON capture_sessions
  FOR EACH ROW EXECUTE FUNCTION protect_desktop_capture_context();
