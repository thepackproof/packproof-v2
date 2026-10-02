-- Exact RGB8 research commitments. Opening material is service-private and never exported.
CREATE TABLE rnd_zk_enrollments (
 id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL UNIQUE, proof_id TEXT NOT NULL,
 tenant_id TEXT NOT NULL, source_id TEXT NOT NULL, root_digest TEXT NOT NULL,
 circuit_id TEXT NOT NULL CHECK(circuit_id IN ('packproof-rgb8-opaque-4x4-v1','packproof-rgb8-opaque-8x8-v1')),
 source_sha256 TEXT NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 private_witness_json TEXT NOT NULL, source_binding_json TEXT NOT NULL,
 canonical_json TEXT NOT NULL, digest TEXT NOT NULL, signature JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(analysis_id,proof_id,tenant_id) REFERENCES rnd_analyses(id,proof_id,tenant_id),
 FOREIGN KEY(source_id,proof_id,tenant_id) REFERENCES rnd_sources(id,proof_id,tenant_id)
);
CREATE TRIGGER rnd_zk_enrollment_immutable BEFORE UPDATE OR DELETE ON rnd_zk_enrollments
 FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
