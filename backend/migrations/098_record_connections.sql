-- Connection health is a projection with explicit measurement evidence, never
-- inferred from a successful OAuth callback or the time of a historical import.
CREATE TABLE record_connection_state (
 connection_id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 environment TEXT NOT NULL CHECK (environment IN ('sandbox','live')),
 paused BOOLEAN NOT NULL DEFAULT false,
 control_revision BIGINT NOT NULL DEFAULT 0 CHECK (control_revision >= 0),
 last_success_at TIMESTAMPTZ,
 watermark_checked_at TIMESTAMPTZ,
 expected_interval_seconds INTEGER CHECK (expected_interval_seconds BETWEEN 60 AND 604800),
 last_error_code TEXT,
 updated_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY (connection_id,organization_id,environment) REFERENCES platform_integration_accounts(id,merchant_id,environment)
);
CREATE TABLE record_connection_operations (
 id TEXT PRIMARY KEY,
 connection_id TEXT NOT NULL REFERENCES record_connection_state(connection_id),
 organization_id TEXT NOT NULL,
 environment TEXT NOT NULL CHECK (environment IN ('sandbox','live')),
 actor_user_id TEXT NOT NULL REFERENCES users(id),
 action TEXT NOT NULL CHECK (action IN ('test','reconcile')),
 idempotency_key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 control_revision BIGINT NOT NULL CHECK (control_revision >= 0),
 state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 lease_token TEXT,
 lease_expires_at TIMESTAMPTZ,
 next_attempt_at TIMESTAMPTZ NOT NULL,
 error_code TEXT,
 created_at TIMESTAMPTZ NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY (connection_id,organization_id,environment) REFERENCES platform_integration_accounts(id,merchant_id,environment),
 UNIQUE (organization_id,environment,connection_id,actor_user_id,idempotency_key_hash),
 CHECK ((state='running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX record_connection_operations_due ON record_connection_operations(state,next_attempt_at);
