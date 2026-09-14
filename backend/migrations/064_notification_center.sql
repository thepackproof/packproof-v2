CREATE TABLE user_notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  uploads BOOLEAN NOT NULL DEFAULT TRUE,
  evidence BOOLEAN NOT NULL DEFAULT TRUE,
  participants BOOLEAN NOT NULL DEFAULT TRUE,
  shipments BOOLEAN NOT NULL DEFAULT TRUE,
  returns BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE proof_notification_mutes (
  user_id TEXT NOT NULL REFERENCES users(id), proof_id TEXT NOT NULL REFERENCES proofs(id),
  PRIMARY KEY(user_id,proof_id)
);
CREATE TABLE proof_update_notifications (
  id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), user_id TEXT NOT NULL REFERENCES users(id),
  source_event_id TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, read_at TIMESTAMPTZ,
  UNIQUE(user_id,source_event_id)
);
CREATE INDEX proof_updates_user_created ON proof_update_notifications(user_id,created_at DESC);
CREATE TABLE notification_push_devices (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), registered_at TIMESTAMPTZ NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE proof_push_deliveries (
  notification_id TEXT NOT NULL REFERENCES proof_update_notifications(id), token TEXT NOT NULL REFERENCES notification_push_devices(token),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL,
  lease_until TIMESTAMPTZ, sent_at TIMESTAMPTZ, ticket_id TEXT, error_code TEXT,
  receipt_checked_at TIMESTAMPTZ, receipt_status TEXT,
  PRIMARY KEY(notification_id,token)
);
