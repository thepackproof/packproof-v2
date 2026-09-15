-- Provider notifications are distinct from user-authored deletion requests.
-- Receipt/credential removal is not proof that immutable records were erased.
CREATE TABLE ebay_deletion_cases (
 id TEXT PRIMARY KEY,
 environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
 notification_id TEXT NOT NULL,
 subject_user_id TEXT,
 subject_username TEXT,
 state TEXT NOT NULL CHECK(state IN ('CREDENTIAL_REMOVAL_PENDING','REVIEW_REQUIRED')),
 connection_ids JSONB NOT NULL DEFAULT '[]',
 credential_references JSONB NOT NULL DEFAULT '[]',
 affected_proof_ids JSONB NOT NULL DEFAULT '[]',
 attempt_count INTEGER NOT NULL DEFAULT 0,
 last_error_code TEXT,
 next_attempt_at TIMESTAMPTZ,
 received_at TIMESTAMPTZ NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL,
 UNIQUE(environment,notification_id),
 CHECK(subject_user_id IS NOT NULL OR subject_username IS NOT NULL)
);
CREATE INDEX ebay_deletion_subject_id ON ebay_deletion_cases(environment,subject_user_id);
CREATE INDEX ebay_deletion_subject_name ON ebay_deletion_cases(environment,subject_username);
CREATE INDEX ebay_deletion_retry ON ebay_deletion_cases(next_attempt_at) WHERE state='CREDENTIAL_REMOVAL_PENDING';
