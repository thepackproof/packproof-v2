-- Recoverable provider-event scanning; financial facts stay in immutable ledger.
CREATE TABLE billing_provider_reconciliation (
 provider TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')), provider_account TEXT NOT NULL,
 baseline_at TIMESTAMPTZ NOT NULL, covered_through TIMESTAMPTZ,
 window_start TIMESTAMPTZ, window_end TIMESTAMPTZ, cursor TEXT, scan_complete BOOLEAN NOT NULL DEFAULT false,
 state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','RUNNING','COMPLETE','BLOCKED')),
 lease_token TEXT, lease_until TIMESTAMPTZ, next_attempt_at TIMESTAMPTZ NOT NULL,
 last_error_code TEXT, updated_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(provider,environment,provider_account)
);
CREATE TABLE billing_reconciliation_events (
 provider TEXT NOT NULL, environment TEXT NOT NULL, provider_account TEXT NOT NULL, event_reference TEXT NOT NULL,
 provider_created_at TIMESTAMPTZ NOT NULL,
 state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','COMPLETE','IGNORED','FAILED')),
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL, last_error_code TEXT, completed_at TIMESTAMPTZ,
 PRIMARY KEY(provider,environment,provider_account,event_reference)
);
CREATE INDEX billing_reconciliation_event_due ON billing_reconciliation_events(provider,environment,provider_account,state,next_attempt_at,provider_created_at);
CREATE TABLE billing_reconciliation_audit (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL, environment TEXT NOT NULL, provider_account TEXT NOT NULL,
 event_type TEXT NOT NULL CHECK(event_type IN ('SCAN_COMPLETED','SCAN_BLOCKED')),
 window_start TIMESTAMPTZ, window_end TIMESTAMPTZ, error_code TEXT, recorded_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER billing_reconciliation_audit_immutable BEFORE UPDATE OR DELETE ON billing_reconciliation_audit
 FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
