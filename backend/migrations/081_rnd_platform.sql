-- Platform assertions are optional additions; ordinary recording never requires them.
ALTER TABLE rnd_intents ADD CONSTRAINT rnd_intent_actor_binding UNIQUE(id,proof_id,actor_id,tenant_id);
CREATE TABLE rnd_platform_challenges (
 id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, proof_id TEXT NOT NULL, actor_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('REGISTER_KEY','CLOSE_INVENTORY')),
 inventory_digest TEXT CHECK(inventory_digest IS NULL OR inventory_digest ~ '^[a-f0-9]{64}$'),
 expected_hash TEXT NOT NULL CHECK(expected_hash ~ '^[a-f0-9]{64}$'),
 canonical_json TEXT NOT NULL,digest TEXT NOT NULL,signature JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL,expires_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(intent_id,proof_id,actor_id,tenant_id) REFERENCES rnd_intents(id,proof_id,actor_id,tenant_id),
 UNIQUE(id,proof_id,actor_id,tenant_id),
 CHECK((purpose='CLOSE_INVENTORY')=(inventory_digest IS NOT NULL))
);
CREATE INDEX rnd_platform_challenge_intent ON rnd_platform_challenges(intent_id,purpose,created_at);
CREATE TABLE rnd_platform_keys (
 key_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id),
 registered_challenge_id TEXT NOT NULL UNIQUE REFERENCES rnd_platform_challenges(id),
 key_json JSONB NOT NULL,receipt_base64 TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE rnd_platform_key_counters (
 key_id TEXT PRIMARY KEY REFERENCES rnd_platform_keys(key_id),
 counter BIGINT NOT NULL DEFAULT 0 CHECK(counter>=0 AND counter<=4294967295)
);
CREATE TABLE rnd_platform_results (
 challenge_id TEXT PRIMARY KEY,proof_id TEXT NOT NULL,actor_id TEXT NOT NULL,tenant_id TEXT NOT NULL,
 platform TEXT NOT NULL CHECK(platform IN ('android','ios')),
 state TEXT NOT NULL CHECK(state IN ('VALIDATED','INVALID','UNSUPPORTED')),
 request_digest TEXT NOT NULL,canonical_json TEXT NOT NULL,digest TEXT NOT NULL,signature JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(challenge_id,proof_id,actor_id,tenant_id) REFERENCES rnd_platform_challenges(id,proof_id,actor_id,tenant_id)
);
CREATE TRIGGER rnd_platform_challenge_immutable BEFORE UPDATE OR DELETE ON rnd_platform_challenges FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
CREATE TRIGGER rnd_platform_key_immutable BEFORE UPDATE OR DELETE ON rnd_platform_keys FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
CREATE TRIGGER rnd_platform_result_immutable BEFORE UPDATE OR DELETE ON rnd_platform_results FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
CREATE FUNCTION rnd_platform_counter_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.key_id<>OLD.key_id OR NEW.counter<=OLD.counter THEN RAISE EXCEPTION 'RND_PLATFORM_COUNTER_MONOTONIC'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER rnd_platform_counter_monotonic BEFORE UPDATE OR DELETE ON rnd_platform_key_counters FOR EACH ROW EXECUTE FUNCTION rnd_platform_counter_guard();
