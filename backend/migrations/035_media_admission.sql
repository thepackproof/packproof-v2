-- Additive upload budgets. Account is the explicit billing scope until organization
-- entitlements provide a stronger shared limit. Failed ingress is never refunded.
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS object_version_id TEXT;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS staging_version_id TEXT;
CREATE TABLE IF NOT EXISTS media_admission_accounts (
  actor_user_id TEXT PRIMARY KEY REFERENCES users(id),
  reservation_day DATE NOT NULL,
  reserved_bytes BIGINT NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0)
);
CREATE TABLE IF NOT EXISTS evidence_upload_admissions (
  evidence_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL DEFAULT 'ROOT' CHECK (source_kind IN ('ROOT','STAGE')),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  staging_key TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  declared_bytes BIGINT,
  reserved_bytes BIGINT NOT NULL CHECK (reserved_bytes > 0 AND reserved_bytes <= 250000000),
  ingress_bytes BIGINT NOT NULL DEFAULT 0 CHECK (ingress_bytes >= 0),
  ingress_limit_bytes BIGINT NOT NULL CHECK (ingress_limit_bytes > 0),
  state TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','RECEIVING','RECEIVED','COMMITTED','EXPIRED','DISCARDED')),
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ,
  staging_version_id TEXT,
  cleanup_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS evidence_upload_admissions_actor ON evidence_upload_admissions(actor_user_id, state, expires_at);
CREATE INDEX IF NOT EXISTS evidence_upload_admissions_cleanup ON evidence_upload_admissions(expires_at) WHERE cleanup_at IS NULL;
ALTER TABLE evidence_upload_parts ADD COLUMN IF NOT EXISTS object_version_id TEXT;
-- Historical sessions retain their historical parser ceiling; new sessions set
-- the five-minute ceiling explicitly when authorized.
ALTER TABLE capture_sessions ADD COLUMN IF NOT EXISTS max_duration_ms INTEGER;

ALTER TABLE commerce_stage_evidence ADD COLUMN IF NOT EXISTS object_version_id TEXT;
ALTER TABLE commerce_stage_evidence ADD COLUMN IF NOT EXISTS staging_version_id TEXT;
