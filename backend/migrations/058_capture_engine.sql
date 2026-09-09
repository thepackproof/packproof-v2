-- Portable capture metadata is additive. Existing source objects/manifests remain unchanged.
CREATE TABLE capture_intents (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), actor_user_id TEXT NOT NULL REFERENCES users(id),
 token_sha256 TEXT NOT NULL UNIQUE, context_json JSONB NOT NULL, surfaces JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ,
 session_id TEXT UNIQUE REFERENCES capture_sessions(id)
);
CREATE INDEX capture_intents_actor ON capture_intents(actor_user_id,created_at);
CREATE TABLE capture_engine_sessions (
 session_id TEXT PRIMARY KEY REFERENCES capture_sessions(id), intent_id TEXT NOT NULL UNIQUE REFERENCES capture_intents(id),
 proof_id TEXT NOT NULL REFERENCES proofs(id), actor_user_id TEXT NOT NULL REFERENCES users(id),
 context_json JSONB NOT NULL, context_sha256 TEXT NOT NULL,
 manifest_json JSONB, manifest_sha256 TEXT, sealed_at TIMESTAMPTZ,
 CHECK ((manifest_json IS NULL) = (manifest_sha256 IS NULL)), CHECK ((manifest_json IS NULL) = (sealed_at IS NULL))
);
CREATE TABLE capture_engine_batches (
 session_id TEXT NOT NULL REFERENCES capture_engine_sessions(session_id), sequence INTEGER NOT NULL CHECK(sequence>=0),
 batch_sha256 TEXT NOT NULL, body_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(session_id,sequence)
);
CREATE FUNCTION protect_capture_intent() RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CAPTURE_INTENT_IMMUTABLE'; END IF;
 IF (to_jsonb(NEW)-ARRAY['consumed_at','session_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['consumed_at','session_id'])
 OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL OR NEW.session_id IS NULL
 OR NOT EXISTS(SELECT 1 FROM capture_sessions c WHERE c.id=NEW.session_id AND c.proof_id=OLD.proof_id AND c.actor_user_id=OLD.actor_user_id)
 THEN RAISE EXCEPTION 'CAPTURE_INTENT_IMMUTABLE'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER capture_intent_guard BEFORE UPDATE OR DELETE ON capture_intents FOR EACH ROW EXECUTE PROCEDURE protect_capture_intent();
CREATE FUNCTION protect_capture_engine() RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CAPTURE_ENGINE_IMMUTABLE'; END IF;
 IF (to_jsonb(NEW)-ARRAY['manifest_json','manifest_sha256','sealed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['manifest_json','manifest_sha256','sealed_at'])
 OR OLD.sealed_at IS NOT NULL OR NEW.sealed_at IS NULL OR NEW.manifest_json IS NULL
 THEN RAISE EXCEPTION 'CAPTURE_ENGINE_IMMUTABLE'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER capture_engine_guard BEFORE UPDATE OR DELETE ON capture_engine_sessions FOR EACH ROW EXECUTE PROCEDURE protect_capture_engine();
CREATE FUNCTION protect_capture_batch() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'CAPTURE_JOURNAL_IMMUTABLE'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER capture_batch_guard BEFORE UPDATE OR DELETE ON capture_engine_batches FOR EACH ROW EXECUTE PROCEDURE protect_capture_batch();
