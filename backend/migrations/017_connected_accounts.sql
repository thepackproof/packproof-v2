-- User-linked connected accounts (eBay, Shopify, Google, Meta/Facebook).
-- OAuth tokens are never stored in this table. The credential_reference points at
-- the existing integration credential store (Secrets Manager / memory / env).

CREATE TABLE connected_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  provider TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  external_account_name TEXT,
  status TEXT NOT NULL,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  credential_reference TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  disconnected_at TIMESTAMPTZ,
  CONSTRAINT connected_accounts_status_check CHECK (
    status IN ('CONNECTED', 'NEEDS_REAUTH', 'DISCONNECTED', 'ERROR')
  ),
  CONSTRAINT connected_accounts_provider_check CHECK (
    provider IN ('ebay', 'shopify', 'google', 'facebook')
  )
);

CREATE UNIQUE INDEX connected_accounts_user_provider_external_uq
  ON connected_accounts (user_id, provider, external_account_id);

CREATE INDEX connected_accounts_user_idx
  ON connected_accounts (user_id, provider, status);

CREATE UNIQUE INDEX connected_accounts_provider_external_active_uq
  ON connected_accounts (provider, external_account_id)
  WHERE status IN ('CONNECTED', 'NEEDS_REAUTH', 'ERROR');

-- Account-level audit. Proof audit_events stay proof-scoped and untouched.
CREATE TABLE account_audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users (id),
  connected_account_id TEXT,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL,
  event_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX account_audit_events_actor_idx
  ON account_audit_events (actor_user_id, created_at);

CREATE INDEX account_audit_events_account_idx
  ON account_audit_events (connected_account_id, created_at);

CREATE TRIGGER account_audit_events_immutable_update
  BEFORE UPDATE ON account_audit_events
  FOR EACH ROW
  EXECUTE PROCEDURE reject_audit_mutation();

CREATE TRIGGER account_audit_events_immutable_delete
  BEFORE DELETE ON account_audit_events
  FOR EACH ROW
  EXECUTE PROCEDURE reject_audit_mutation();
