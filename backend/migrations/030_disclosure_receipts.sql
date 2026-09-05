-- Scoped views extend the existing bearer link and participant boundary.
CREATE TABLE proof_disclosure_grants (
  access_link_id TEXT NOT NULL REFERENCES proof_access_links(id),
  scope_version INTEGER NOT NULL CHECK(scope_version > 0),
  policy_version TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('BUYER_RECEIPT','CLAIMS_REVIEW','PUBLIC_SAMPLE')),
  fields JSONB NOT NULL,
  media JSONB NOT NULL,
  preview_hash TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(access_link_id, scope_version)
);
CREATE TABLE proof_media_derivatives (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  source_sha256 TEXT NOT NULL,
  transform_version TEXT NOT NULL,
  transform JSONB NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING','READY','REVIEWED','FAILED')),
  sha256 TEXT,
  object_key TEXT,
  content_type TEXT,
  byte_size BIGINT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  reviewed_by_user_id TEXT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  failure_code TEXT,
  UNIQUE(proof_id,evidence_id,source_sha256,transform_version,transform)
);
CREATE TABLE user_verified_contacts (
  user_id TEXT NOT NULL REFERENCES users(id),
  email_normalized TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('COGNITO')),
  PRIMARY KEY(user_id,email_normalized)
);
CREATE TABLE proof_receipt_preferences (
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  opted_in BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(proof_id,user_id)
);
ALTER TABLE proof_notification_subscriptions ADD COLUMN recipient_user_id TEXT REFERENCES users(id);
ALTER TABLE proof_notification_subscriptions ADD COLUMN recipient_grant_id TEXT REFERENCES proof_access_links(id);
ALTER TABLE proof_notification_outbox ADD COLUMN lease_token TEXT;
ALTER TABLE proof_notification_outbox ADD COLUMN lease_until TIMESTAMPTZ;
ALTER TABLE proof_notification_outbox ADD COLUMN exhausted_at TIMESTAMPTZ;
CREATE OR REPLACE FUNCTION immutable_disclosure_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Disclosure scope versions are append-only'; END; $$;
CREATE TRIGGER disclosure_grant_immutable BEFORE UPDATE OR DELETE ON proof_disclosure_grants FOR EACH ROW EXECUTE FUNCTION immutable_disclosure_grant();
ALTER TABLE proof_media_derivatives ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1 CHECK(attempt_count BETWEEN 1 AND 3);
ALTER TABLE proof_media_derivatives ADD COLUMN lease_until TIMESTAMPTZ;
CREATE OR REPLACE FUNCTION derivative_lineage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.status='REVIEWED' OR NEW.proof_id<>OLD.proof_id OR NEW.evidence_id<>OLD.evidence_id OR NEW.source_sha256<>OLD.source_sha256 OR NEW.transform_version<>OLD.transform_version OR NEW.transform<>OLD.transform OR (OLD.status='READY' AND (NEW.status<>'REVIEWED' OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.object_key IS DISTINCT FROM OLD.object_key OR NEW.byte_size IS DISTINCT FROM OLD.byte_size OR NEW.content_type IS DISTINCT FROM OLD.content_type)) THEN RAISE EXCEPTION 'DERIVATIVE_IMMUTABLE'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER derivative_lineage_immutable BEFORE UPDATE OR DELETE ON proof_media_derivatives FOR EACH ROW EXECUTE FUNCTION derivative_lineage_guard();
