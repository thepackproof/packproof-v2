-- Supplemental acquisition context is client-reported; never a server timing attestation.
CREATE TABLE capture_session_reports (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES capture_sessions(id),
  reporter_user_id TEXT NOT NULL REFERENCES users(id),
  context_sha256 TEXT NOT NULL,
  interrupted BOOLEAN,
  recorded_duration_ms BIGINT CHECK (recorded_duration_ms BETWEEN 0 AND 1800000),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(session_id,context_sha256),
  CHECK(interrupted IS NOT NULL OR recorded_duration_ms IS NOT NULL)
);
CREATE OR REPLACE FUNCTION protect_capture_report() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CAPTURE_REPORT_IMMUTABLE' USING ERRCODE='P0001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER capture_report_immutable BEFORE UPDATE OR DELETE ON capture_session_reports FOR EACH ROW EXECUTE PROCEDURE protect_capture_report();
