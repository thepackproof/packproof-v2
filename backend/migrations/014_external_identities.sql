-- Multiple linked identities belong to one canonical PackProof user.
-- Provider subject IDs are authoritative. Handles and display names are not.
-- Marketplace connections (eBay, etc.) remain on integration_connections.

ALTER TABLE auth_identities
  ADD COLUMN provider_handle TEXT,
  ADD COLUMN provider_display_name TEXT,
  ADD COLUMN avatar_url TEXT,
  ADD COLUMN last_refreshed_at TIMESTAMPTZ,
  ADD COLUMN can_authenticate BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN visible_on_profile BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN searchable BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX auth_identities_user_provider_uq
  ON auth_identities (user_id, provider);

CREATE INDEX auth_identities_user_idx
  ON auth_identities (user_id);

-- Short-lived authorization attempts for SSO linking and marketplace OAuth.
-- Tokens and client secrets are never stored here.
CREATE TABLE oauth_authorization_attempts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL,
  user_id TEXT REFERENCES users (id),
  state TEXT NOT NULL,
  code_verifier TEXT,
  redirect_uri TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT oauth_authorization_attempts_state_uq UNIQUE (state),
  CONSTRAINT oauth_authorization_attempts_purpose_check CHECK (
    purpose IN ('authenticate', 'link', 'marketplace_connect')
  )
);

CREATE INDEX oauth_authorization_attempts_expires_idx
  ON oauth_authorization_attempts (expires_at);
