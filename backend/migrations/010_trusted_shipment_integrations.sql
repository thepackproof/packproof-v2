-- Trusted carrier integration runtime.
-- Connections store a credential *reference*, never provider tokens.
-- Bindings associate one shipment connection with a transaction.
-- Webhook receipts provide replay protection without storing secrets.

CREATE TABLE integration_connections (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users (id),
  adapter_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_account_reference TEXT,
  credential_reference TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT integration_connections_status_check CHECK (
    status IN ('ACTIVE', 'DISABLED', 'NEEDS_REAUTH')
  )
);

CREATE INDEX integration_connections_owner_idx
  ON integration_connections (owner_user_id, adapter_key);

CREATE TABLE transaction_shipment_connections (
  transaction_id TEXT PRIMARY KEY REFERENCES transactions (id),
  connection_id TEXT NOT NULL REFERENCES integration_connections (id),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE shipment_sync_states (
  transaction_id TEXT PRIMARY KEY REFERENCES transactions (id),
  connection_id TEXT NOT NULL REFERENCES integration_connections (id),
  last_attempted_at TIMESTAMPTZ,
  last_succeeded_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_retryable BOOLEAN,
  provider_cursor TEXT,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE integration_webhook_receipts (
  id TEXT PRIMARY KEY,
  adapter_key TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  signature_sha256 TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT integration_webhook_receipts_event_uq UNIQUE (adapter_key, provider_event_id)
);
