-- A share fixes an existing immutable package. It never grants a live record.
CREATE TABLE record_snapshot_shares (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), organization_id TEXT NOT NULL,
 environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
 owner_kind TEXT NOT NULL CHECK(owner_kind IN ('HUMAN','PARTNER')), owner_context JSONB NOT NULL,
 target_kind TEXT NOT NULL CHECK(target_kind IN ('CANONICAL_EXPORT','OPERATIONAL_SNAPSHOT')), target_id TEXT NOT NULL,
 selection_sha256 TEXT NOT NULL CHECK(selection_sha256 ~ '^[a-f0-9]{64}$'), token_sha256 TEXT NOT NULL UNIQUE CHECK(token_sha256 ~ '^[a-f0-9]{64}$'),
 recipient_hint TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 revoked_at TIMESTAMPTZ, revoked_by TEXT REFERENCES users(id), revoke_reason TEXT,
 FOREIGN KEY(proof_id,organization_id,environment) REFERENCES platform_proof_ownership(proof_id,merchant_id,environment),
 CHECK(expires_at>created_at), CHECK((revoked_at IS NULL)=(revoked_by IS NULL)), CHECK((revoked_at IS NULL)=(revoke_reason IS NULL))
);
CREATE INDEX record_snapshot_shares_proof ON record_snapshot_shares(proof_id,created_at DESC,id DESC);
CREATE FUNCTION preserve_record_share_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.id,NEW.proof_id,NEW.organization_id,NEW.environment,NEW.owner_kind,NEW.owner_context,NEW.target_kind,NEW.target_id,NEW.selection_sha256,NEW.token_sha256,NEW.recipient_hint,NEW.created_by,NEW.created_at,NEW.expires_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.proof_id,OLD.organization_id,OLD.environment,OLD.owner_kind,OLD.owner_context,OLD.target_kind,OLD.target_id,OLD.selection_sha256,OLD.token_sha256,OLD.recipient_hint,OLD.created_by,OLD.created_at,OLD.expires_at)
 OR (OLD.revoked_at IS NOT NULL AND ROW(NEW.revoked_at,NEW.revoked_by,NEW.revoke_reason) IS DISTINCT FROM ROW(OLD.revoked_at,OLD.revoked_by,OLD.revoke_reason))
 THEN RAISE EXCEPTION 'A share scope is immutable and revocation is permanent'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER record_snapshot_share_scope BEFORE UPDATE OR DELETE ON record_snapshot_shares FOR EACH ROW EXECUTE FUNCTION preserve_record_share_scope();
INSERT INTO policy_recovery_tables(table_name,key_columns) VALUES('record_snapshot_shares',ARRAY['id']);
CREATE TRIGGER record_snapshot_shares_policy_recovery AFTER INSERT OR UPDATE OR DELETE ON record_snapshot_shares FOR EACH ROW EXECUTE FUNCTION capture_policy_recovery_change();
