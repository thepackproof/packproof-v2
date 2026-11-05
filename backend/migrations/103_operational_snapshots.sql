-- Explicit new operational profile. No signing/storage/runtime grants or rollout
-- authorization are implied; deployment qualification must name this exact profile.
CREATE TABLE operational_snapshot_candidates (
 snapshot_id TEXT PRIMARY KEY,
 proof_id TEXT NOT NULL REFERENCES proofs(id),
 organization_id TEXT NOT NULL,
 environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
 revision INTEGER NOT NULL CHECK(revision>0),
 actor_user_id TEXT NOT NULL REFERENCES users(id),
 membership_id TEXT NOT NULL,
 location_id TEXT,
 manifest_json TEXT NOT NULL,
 manifest_sha256 TEXT NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 request_json TEXT NOT NULL,
 request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 idempotency_key_hash TEXT NOT NULL CHECK(idempotency_key_hash ~ '^[a-f0-9]{64}$'),
 input_sha256 TEXT NOT NULL CHECK(input_sha256 ~ '^[a-f0-9]{64}$'),
 created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(proof_id,organization_id,environment) REFERENCES platform_proof_ownership(proof_id,merchant_id,environment),
 FOREIGN KEY(membership_id,organization_id) REFERENCES platform_memberships(id,organization_id),
 UNIQUE(proof_id,revision),
 UNIQUE(organization_id,environment,actor_user_id,idempotency_key_hash)
);
CREATE TRIGGER operational_snapshot_candidates_immutable BEFORE UPDATE OR DELETE ON operational_snapshot_candidates
 FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TABLE operational_snapshot_delivery (
 snapshot_id TEXT PRIMARY KEY REFERENCES operational_snapshot_candidates(snapshot_id),
 state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','LEASED','ACCEPTED','DEAD_LETTER')),
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TIMESTAMPTZ NOT NULL,
 lease_token TEXT,
 lease_until TIMESTAMPTZ,
 error_code TEXT
);
CREATE INDEX operational_snapshot_work ON operational_snapshot_delivery(state,next_attempt_at,lease_until);
CREATE TABLE operational_snapshot_results (
 snapshot_id TEXT PRIMARY KEY REFERENCES operational_snapshot_candidates(snapshot_id),
 proof_id TEXT NOT NULL REFERENCES proofs(id),
 bundle_json TEXT NOT NULL,
 bundle_sha256 TEXT NOT NULL CHECK(bundle_sha256 ~ '^[a-f0-9]{64}$'),
 receipt_json JSONB NOT NULL,
 accepted_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER operational_snapshot_results_immutable BEFORE UPDATE OR DELETE ON operational_snapshot_results
 FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
-- Row-locking SELECT normally requires UPDATE rights. This narrow read-only
-- function lets qualified runtimes lock current authority without granting
-- UPDATE on location grants, ownership, account state or their identity keys.
CREATE FUNCTION lock_operational_snapshot_authority(target_proof TEXT,target_organization TEXT,target_environment TEXT,target_user TEXT,target_membership TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE account_status TEXT; member_role TEXT; scoped BOOLEAN; site TEXT; found_id TEXT;
BEGIN
 SELECT u.status INTO account_status FROM public.users u WHERE u.id=target_user FOR UPDATE;
 IF account_status IS DISTINCT FROM 'ACTIVE' OR EXISTS(SELECT 1 FROM public.platform_principals p WHERE p.actor_user_id=target_user) THEN RETURN false; END IF;
 SELECT m.role,m.location_scoped INTO member_role,scoped FROM public.platform_memberships m JOIN public.platform_organizations o ON o.id=m.organization_id
 WHERE m.id=target_membership AND m.user_id=target_user AND m.organization_id=target_organization AND m.revoked_at IS NULL
 AND o.enabled=true AND o.kind='MERCHANT' AND o.environment=target_environment FOR SHARE OF m,o;
 IF member_role IS NULL OR member_role NOT IN ('OWNER','ADMIN') THEN RETURN false; END IF;
 SELECT o.proof_id,s.location_id INTO found_id,site FROM public.platform_proof_ownership o LEFT JOIN public.record_state s ON s.proof_id=o.proof_id
 WHERE o.proof_id=target_proof AND o.merchant_id=target_organization AND o.environment=target_environment FOR SHARE OF o;
 IF found_id IS NULL THEN RETURN false; END IF;
 IF site IS NULL THEN RETURN NOT scoped; END IF;
 SELECT l.id INTO found_id FROM public.record_locations l WHERE l.id=site AND l.organization_id=target_organization FOR SHARE;
 IF found_id IS NULL THEN RETURN false; END IF;
 IF scoped THEN
  SELECT g.membership_id INTO found_id FROM public.record_membership_locations g WHERE g.membership_id=target_membership AND g.organization_id=target_organization AND g.location_id=site FOR SHARE;
  IF found_id IS NULL THEN RETURN false; END IF;
 END IF;
 RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION lock_operational_snapshot_authority(TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
