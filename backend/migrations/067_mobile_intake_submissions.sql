-- Actor-scoped transport receipts, never a parallel transaction or Proof lifecycle.
CREATE TABLE intake_scoped_sessions (
  id text PRIMARY KEY,
  actor_user_id text NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX intake_sessions_actor ON intake_scoped_sessions(actor_user_id,expires_at);
CREATE TABLE intake_submissions (
  id text PRIMARY KEY,
  actor_user_id text NOT NULL REFERENCES users(id),
  client_submission_id text NOT NULL,
  session_id text REFERENCES intake_scoped_sessions(id),
  request_hash text NOT NULL,
  resolution_hash text,
  surface text NOT NULL CHECK(surface IN ('ANDROID_SHARE','IOS_SHARE','EXPLICIT_PASTE')),
  state text NOT NULL CHECK(state IN ('RECEIVED','RESOLVING','READY','NEEDS_CONNECTION','NEEDS_SELECTION','INVALID','RETRYABLE_FAILED','DISMISSED')),
  hints jsonb NOT NULL,
  raw_text text,
  raw_expires_at timestamptz NOT NULL,
  transaction_id text REFERENCES transactions(id),
  proof_id text REFERENCES proofs(id),
  next_action text NOT NULL,
  error_code text,
  message text NOT NULL,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  lease_token text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(actor_user_id,client_submission_id)
);
CREATE INDEX intake_submissions_owner ON intake_submissions(actor_user_id,updated_at DESC);
CREATE INDEX intake_submissions_retry ON intake_submissions(state,next_attempt_at);
CREATE INDEX intake_submissions_retention ON intake_submissions(raw_expires_at) WHERE raw_text IS NOT NULL;
