-- Isolated F10 signed candidate registry. No raw partner examples or participant rows.
CREATE TABLE rnd_learning_reports (
 id TEXT PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
 model_sha256 TEXT NOT NULL CHECK(model_sha256 ~ '^[a-f0-9]{64}$'),
 signer_key_id TEXT NOT NULL CHECK(signer_key_id ~ '^[a-f0-9]{64}$'),
 signed_candidate JSONB NOT NULL,
 summary_json JSONB NOT NULL,
 imported_by TEXT NOT NULL REFERENCES users(id),
 imported_at TIMESTAMPTZ NOT NULL,
 release_authorized BOOLEAN NOT NULL DEFAULT FALSE CHECK(release_authorized=FALSE)
);
CREATE INDEX rnd_learning_reports_imported ON rnd_learning_reports(imported_at DESC,id);
CREATE TRIGGER rnd_learning_report_immutable BEFORE UPDATE OR DELETE ON rnd_learning_reports FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
