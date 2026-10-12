-- Fixed, bounded native sidecars append to a sealed final-file inventory. Core media remains unchanged.
CREATE TABLE rnd_capture_sidecar_parts (
 intent_id TEXT NOT NULL REFERENCES rnd_intents(id), file_name TEXT NOT NULL,
 part_index INTEGER NOT NULL CHECK(part_index>=0 AND part_index<9), part_count INTEGER NOT NULL CHECK(part_count BETWEEN 1 AND 9),
 file_sha256 TEXT NOT NULL, file_byte_length INTEGER NOT NULL CHECK(file_byte_length BETWEEN 1 AND 2097216),
 part_sha256 TEXT NOT NULL, part_byte_length INTEGER NOT NULL CHECK(part_byte_length BETWEEN 1 AND 262144),
 object_key TEXT NOT NULL, object_version_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(intent_id,file_name,part_index)
);
CREATE TABLE rnd_capture_sidecars (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), tenant_id TEXT NOT NULL, subject_id TEXT NOT NULL,
 intent_id TEXT NOT NULL REFERENCES rnd_intents(id), actor_id TEXT NOT NULL REFERENCES users(id),
 capture_session_id TEXT NOT NULL REFERENCES capture_sessions(id), parent_evidence_id TEXT NOT NULL,
 file_name TEXT NOT NULL, object_key TEXT NOT NULL, object_version_id TEXT NOT NULL,
 sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 2097216),
 mime_type TEXT NOT NULL, frame_reference JSONB, canonical_json TEXT NOT NULL, digest TEXT NOT NULL,
 signature JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL,
 UNIQUE(intent_id,file_name), FOREIGN KEY(subject_id,proof_id,tenant_id) REFERENCES rnd_subjects(id,proof_id,tenant_id)
);
CREATE TRIGGER rnd_sidecar_part_immutable BEFORE UPDATE OR DELETE ON rnd_capture_sidecar_parts FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
CREATE TRIGGER rnd_sidecar_immutable BEFORE UPDATE OR DELETE ON rnd_capture_sidecars FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
