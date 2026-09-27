-- Administrative capability is tied to internal identity, never a runtime email match.
ALTER TABLE users ADD COLUMN sessions_revoked_before TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN admin_version INTEGER NOT NULL DEFAULT 0 CHECK(admin_version>=0);
CREATE TABLE user_system_roles (
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role='SYSTEM_ADMIN'),
  granted_at TIMESTAMPTZ NOT NULL,
  granted_by TEXT REFERENCES users(id),
  PRIMARY KEY(user_id,role)
);
CREATE TABLE system_admin_audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 8 AND 1000),
  before_json JSONB NOT NULL,
  after_json JSONB NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical')),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX system_admin_audit_at ON system_admin_audit_events(created_at DESC,id DESC);
CREATE INDEX system_admin_audit_target ON system_admin_audit_events(target_type,target_id,created_at DESC);
CREATE INDEX system_admin_audit_actor ON system_admin_audit_events(actor_id,created_at DESC);
CREATE TRIGGER system_admin_audit_immutable BEFORE UPDATE OR DELETE ON system_admin_audit_events
  FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
CREATE TABLE admin_command_receipts (
  actor_id TEXT NOT NULL REFERENCES users(id),
  operation_id TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(actor_id,operation_id)
);
CREATE TRIGGER admin_command_receipts_immutable BEFORE UPDATE OR DELETE ON admin_command_receipts
  FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
CREATE TABLE system_feature_flags (
  key TEXT PRIMARY KEY CHECK(key IN ('REGISTRATION_PAUSED','NEW_CAPTURE_PAUSED')),
  enabled BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT REFERENCES users(id)
);
INSERT INTO system_feature_flags(key,updated_at) VALUES ('REGISTRATION_PAUSED',CURRENT_TIMESTAMP),('NEW_CAPTURE_PAUSED',CURRENT_TIMESTAMP);
-- Adjust the existing consented capture allowance; this is not money or a payment.
CREATE TABLE billing_allowance_adjustments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  offer_period_id TEXT NOT NULL REFERENCES billing_account_offer_periods(id),
  delta INTEGER NOT NULL CHECK(delta BETWEEN -10000 AND 10000 AND delta<>0),
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  operation_id TEXT NOT NULL UNIQUE REFERENCES system_admin_audit_events(operation_id),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX billing_allowance_adjustments_period ON billing_allowance_adjustments(offer_period_id);
CREATE INDEX billing_allowance_adjustments_user ON billing_allowance_adjustments(user_id,created_at DESC);
CREATE TRIGGER billing_allowance_adjustments_immutable BEFORE UPDATE OR DELETE ON billing_allowance_adjustments
  FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
