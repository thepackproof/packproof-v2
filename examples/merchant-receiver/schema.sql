-- Run in the merchant receiver's own database, not the PackProof database.
CREATE TABLE receiver_inbox (
 provider TEXT NOT NULL, subscription_id TEXT NOT NULL, event_id TEXT NOT NULL,
 tenant_id TEXT NOT NULL, proof_id TEXT NOT NULL, body_sha256 TEXT NOT NULL,
 received_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(provider,subscription_id,event_id)
);
CREATE TABLE receiver_jobs (
 effect_key TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, event_id TEXT NOT NULL,
 proof_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','DONE')),
 created_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ
);
-- Example local business effect. Actual integrations fetch authorized current
-- state; an out-of-order notification must never regress a resource snapshot.
CREATE TABLE receiver_reconciliation_requests (
 effect_key TEXT PRIMARY KEY, proof_id TEXT NOT NULL, requested_at TIMESTAMPTZ NOT NULL
);
