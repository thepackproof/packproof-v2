-- Governed study datasets are provisioned internally, never implicitly at capture.
-- No account, Proof, media, order, or provider identifiers enter these tables.
CREATE TABLE program_datasets (
 dataset_ref TEXT PRIMARY KEY CHECK(dataset_ref ~ '^pr_[a-f0-9]{32}$'),
 key_version TEXT NOT NULL,
 key_fingerprint TEXT NOT NULL CHECK(key_fingerprint ~ '^[a-f0-9]{64}$'),
 statement_version TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE program_consent_events (
 event_ref TEXT PRIMARY KEY CHECK(event_ref ~ '^pr_[a-f0-9]{32}$'),
 dataset_ref TEXT NOT NULL REFERENCES program_datasets(dataset_ref),
 merchant_ref TEXT NOT NULL CHECK(merchant_ref ~ '^pr_[a-f0-9]{32}$'),
 decision TEXT NOT NULL CHECK(decision IN ('grant','withdraw')),
 statement_version TEXT NOT NULL,
 facts_sha256 TEXT NOT NULL,
 recorded_at TIMESTAMPTZ NOT NULL,
 sequence BIGSERIAL UNIQUE NOT NULL
);
CREATE INDEX program_consent_scope ON program_consent_events(dataset_ref,merchant_ref,sequence);
CREATE TABLE program_timing_events (
 event_ref TEXT PRIMARY KEY CHECK(event_ref ~ '^pr_[a-f0-9]{32}$'),
 dataset_ref TEXT NOT NULL REFERENCES program_datasets(dataset_ref),
 merchant_ref TEXT NOT NULL CHECK(merchant_ref ~ '^pr_[a-f0-9]{32}$'),
 attempt_ref TEXT NOT NULL CHECK(attempt_ref ~ '^pr_[a-f0-9]{32}$'),
 consent_event_ref TEXT NOT NULL REFERENCES program_consent_events(event_ref),
 task_kind TEXT NOT NULL CHECK(task_kind IN ('packproof','ordinary_baseline')),
 phase TEXT NOT NULL CHECK(phase IN ('started','preflight','recording','upload','confirmation','finalization','ended')),
 outcome TEXT NOT NULL CHECK(outcome IN ('pending','succeeded','failed','cancelled')),
 device_class TEXT NOT NULL CHECK(device_class IN ('s24_ultra','a16_5g','other_android','web','unknown')),
 channel TEXT NOT NULL CHECK(channel IN ('ebay','stripe','paypal','manual','other','unknown')),
 error_code TEXT CHECK(error_code IN ('network','authentication','quota','storage','capability','integrity','provider','cancelled','unknown')),
 client_started_at TIMESTAMPTZ NOT NULL,
 elapsed_ms BIGINT NOT NULL CHECK(elapsed_ms BETWEEN 0 AND 86400000),
 active_ms BIGINT NOT NULL CHECK(active_ms BETWEEN 0 AND elapsed_ms),
 offline_ms BIGINT NOT NULL CHECK(offline_ms BETWEEN 0 AND elapsed_ms),
 unattended_ms BIGINT NOT NULL CHECK(unattended_ms BETWEEN 0 AND elapsed_ms),
 facts_sha256 TEXT NOT NULL,
 recorded_at TIMESTAMPTZ NOT NULL,
 sequence BIGSERIAL UNIQUE NOT NULL,
 CHECK(active_ms+unattended_ms<=elapsed_ms)
);
CREATE INDEX program_timing_scope ON program_timing_events(dataset_ref,merchant_ref,attempt_ref,sequence);
CREATE UNIQUE INDEX program_attempt_started ON program_timing_events(dataset_ref,merchant_ref,attempt_ref) WHERE phase='started';
CREATE UNIQUE INDEX program_attempt_ended ON program_timing_events(dataset_ref,merchant_ref,attempt_ref) WHERE phase='ended';
CREATE TRIGGER program_dataset_immutable BEFORE UPDATE OR DELETE ON program_datasets FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
CREATE TRIGGER program_consent_immutable BEFORE UPDATE OR DELETE ON program_consent_events FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
CREATE TRIGGER program_timing_immutable BEFORE UPDATE OR DELETE ON program_timing_events FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
