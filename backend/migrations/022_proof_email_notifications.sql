-- Durable email subscriptions for the live Proof tracker.
-- Bearer viewing tokens remain hash-only at rest. Tracker tokens are derived
-- from a server-held HMAC secret and the subscription id, so the same secure
-- URL can be reconstructed for future milestone emails without persisting the
-- plaintext token.

CREATE TABLE proof_notification_subscriptions (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs (id),
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  preference TEXT NOT NULL DEFAULT 'IMPORTANT',
  scope TEXT NOT NULL DEFAULT 'SUMMARY',
  access_link_id TEXT NOT NULL REFERENCES proof_access_links (id),
  created_by_user_id TEXT NOT NULL REFERENCES users (id),
  processed_milestones JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT proof_notification_preference_check CHECK (
    preference IN ('IMPORTANT', 'ALL', 'FINAL_ONLY')
  ),
  CONSTRAINT proof_notification_scope_check CHECK (
    scope IN ('STATUS_ONLY', 'SUMMARY', 'EVIDENCE_VIEW')
  )
);

CREATE UNIQUE INDEX proof_notification_active_email_uq
  ON proof_notification_subscriptions (proof_id, email_normalized)
  WHERE revoked_at IS NULL;

CREATE INDEX proof_notification_proof_idx
  ON proof_notification_subscriptions (proof_id, created_at);

CREATE TABLE proof_notification_outbox (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs (id),
  subscription_id TEXT NOT NULL REFERENCES proof_notification_subscriptions (id),
  event_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  CONSTRAINT proof_notification_outbox_attempt_check CHECK (attempt_count >= 0),
  CONSTRAINT proof_notification_outbox_subscription_event_uq UNIQUE (subscription_id, event_key)
);

CREATE INDEX proof_notification_outbox_pending_idx
  ON proof_notification_outbox (next_attempt_at, created_at)
  WHERE sent_at IS NULL AND cancelled_at IS NULL;
