CREATE TABLE IF NOT EXISTS evidence_upload_parts (
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 40),
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (evidence_id, part_number)
);
DROP TRIGGER IF EXISTS upload_part_immutable ON evidence_upload_parts;
CREATE TRIGGER upload_part_immutable BEFORE UPDATE OR DELETE ON evidence_upload_parts FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
