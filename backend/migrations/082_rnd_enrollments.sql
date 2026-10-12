-- Immutable passive ProofPrint enrollment versions; no production capture dependency.
CREATE TABLE rnd_enrollments (
 id TEXT PRIMARY KEY,
 proof_id TEXT NOT NULL REFERENCES proofs(id),
 tenant_id TEXT NOT NULL,
 analysis_id TEXT NOT NULL UNIQUE,
 subject_id TEXT NOT NULL,
 root_digest TEXT NOT NULL CHECK(root_digest ~ '^[a-f0-9]{64}$'),
 source_inventory JSONB NOT NULL,
 frozen_groups JSONB NOT NULL,
 policy_version TEXT NOT NULL,
 supersedes_id TEXT,
 created_at TIMESTAMPTZ NOT NULL,
 UNIQUE(id,proof_id,tenant_id),
 FOREIGN KEY(analysis_id,proof_id,tenant_id) REFERENCES rnd_analyses(id,proof_id,tenant_id),
 FOREIGN KEY(subject_id,proof_id,tenant_id) REFERENCES rnd_subjects(id,proof_id,tenant_id),
 FOREIGN KEY(supersedes_id,proof_id,tenant_id) REFERENCES rnd_enrollments(id,proof_id,tenant_id)
);
CREATE TABLE rnd_enrollment_events (
 id TEXT PRIMARY KEY,
 enrollment_id TEXT NOT NULL REFERENCES rnd_enrollments(id),
 sequence INTEGER NOT NULL CHECK(sequence > 0),
 state TEXT NOT NULL CHECK(state IN ('CANDIDATE','SOURCES_COMMITTED','ANALYZED','UNAVAILABLE','QUALIFIED','LOCKED')),
 previous_digest TEXT,
 canonical_json TEXT NOT NULL,
 digest TEXT NOT NULL UNIQUE,
 signature JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL,
 UNIQUE(enrollment_id,sequence)
);
CREATE TRIGGER rnd_enrollment_immutable BEFORE UPDATE OR DELETE ON rnd_enrollments FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
CREATE TRIGGER rnd_enrollment_event_immutable BEFORE UPDATE OR DELETE ON rnd_enrollment_events FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
