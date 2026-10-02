CREATE TABLE rnd_annotations (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), tenant_id TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id), analysis_id TEXT NOT NULL REFERENCES rnd_analyses(id),
 source_id TEXT NOT NULL REFERENCES rnd_sources(id), supersedes_id TEXT REFERENCES rnd_annotations(id),
 canonical_json TEXT NOT NULL, digest TEXT NOT NULL, signature JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX rnd_annotations_proof ON rnd_annotations(proof_id,created_at,id);
CREATE TRIGGER rnd_annotation_immutable BEFORE UPDATE OR DELETE ON rnd_annotations FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
