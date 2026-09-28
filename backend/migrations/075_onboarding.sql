-- Existing accounts are exempt; only accounts created after this migration enroll.
ALTER TABLE users ADD COLUMN onboarding_completed BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN onboarding_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN first_proof_coaching_completed BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN onboarding_last_step INTEGER;
ALTER TABLE users ADD COLUMN onboarding_enrolled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ALTER COLUMN onboarding_completed SET DEFAULT FALSE;
ALTER TABLE users ALTER COLUMN onboarding_version SET DEFAULT 0;
ALTER TABLE users ALTER COLUMN first_proof_coaching_completed SET DEFAULT FALSE;
ALTER TABLE users ALTER COLUMN onboarding_enrolled SET DEFAULT TRUE;
ALTER TABLE users ADD CONSTRAINT onboarding_step_range CHECK (onboarding_last_step BETWEEN 0 AND 5);
CREATE TABLE onboarding_events (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  event TEXT NOT NULL,
  step INTEGER NOT NULL DEFAULT -1,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, version, event, step)
);
