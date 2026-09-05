-- Additive platform boundary. Canonical Proofs and their manifests stay unchanged.
CREATE TABLE IF NOT EXISTS api_tenants (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'live')),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(owner_user_id, name, environment)
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES api_tenants(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scopes JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS api_keys_tenant ON api_keys(tenant_id);
CREATE TABLE IF NOT EXISTS api_tenant_proofs (
  tenant_id TEXT NOT NULL REFERENCES api_tenants(id),
  external_id TEXT NOT NULL,
  proof_id TEXT NOT NULL UNIQUE REFERENCES proofs(id),
  request_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, external_id)
);
CREATE TABLE IF NOT EXISTS api_idempotency (
  tenant_id TEXT NOT NULL REFERENCES api_tenants(id),
  operation TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, operation, key_hash)
);
CREATE TABLE IF NOT EXISTS api_rate_windows (
  tenant_id TEXT PRIMARY KEY REFERENCES api_tenants(id),
  window_start BIGINT NOT NULL,
  request_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS api_request_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES api_tenants(id),
  key_id TEXT REFERENCES api_keys(id),
  actor_user_id TEXT REFERENCES users(id),
  operation TEXT NOT NULL,
  status INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS api_request_audit_tenant ON api_request_audit(tenant_id, created_at);
CREATE TABLE IF NOT EXISTS proof_outbox (
  sequence BIGSERIAL UNIQUE,
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  audit_id TEXT NOT NULL REFERENCES audit_events(id),
  event_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS proof_outbox_proof ON proof_outbox(proof_id, sequence);
CREATE TABLE IF NOT EXISTS api_webhooks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES api_tenants(id),
  url TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  event_types JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS api_webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES api_webhooks(id),
  event_id TEXT NOT NULL REFERENCES proof_outbox(id),
  state TEXT NOT NULL CHECK (state IN ('pending','sending','delivered','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  lease_token TEXT,
  last_status INTEGER,
  delivered_at TIMESTAMPTZ,
  UNIQUE(webhook_id, event_id)
);
CREATE INDEX IF NOT EXISTS webhook_delivery_due ON api_webhook_deliveries(state, next_attempt_at);

-- Events commit in the same database transaction as the originating domain audit.
-- The platform maps this neutral outbox to tenants; no marketplace enters the core.
CREATE OR REPLACE FUNCTION publish_proof_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_name TEXT;
BEGIN
  event_name := CASE NEW.event_type
    WHEN 'PROOF_CREATED' THEN 'proof.created'
    WHEN 'PARTICIPANT_JOINED' THEN 'participant.joined'
    WHEN 'EVIDENCE_COMMITTED' THEN 'evidence.committed'
    WHEN 'SHIPMENT_EVENT_RECORDED' THEN 'shipment.updated'
    WHEN 'PROOF_FINALIZED' THEN 'proof.finalized'
    WHEN 'PROOF_ACCESSED' THEN 'proof.accessed'
    WHEN 'PROOF_VIEWED_VIA_ACCESS_LINK' THEN 'proof.accessed'
    ELSE NULL END;
  IF event_name IS NOT NULL THEN
    INSERT INTO proof_outbox(id, proof_id, audit_id, event_type, created_at)
    VALUES (NEW.id || ':' || event_name, NEW.proof_id, NEW.id, event_name, NEW.created_at);
  END IF;
  IF NEW.event_type = 'EVIDENCE_COMMITTED' THEN
    INSERT INTO proof_outbox(id, proof_id, audit_id, event_type, created_at)
    VALUES (NEW.id || ':evidence.uploaded', NEW.proof_id, NEW.id, 'evidence.uploaded', NEW.created_at);
  END IF;
  -- Capture completion means qualifying seller media plus the seller's packing
  -- attestation. It is neither adjudication nor Proof finalization.
  IF NEW.event_type IN ('EVIDENCE_COMMITTED', 'ATTESTATION_COMMITTED') THEN
    IF EXISTS (SELECT 1 FROM proofs WHERE id = NEW.proof_id AND workflow_type = 'COMMERCE_SALE')
      AND EXISTS (SELECT 1 FROM evidence e JOIN proof_participants p
        ON p.proof_id = e.proof_id AND p.user_id = e.submitted_by AND p.role = 'SELLER'
        WHERE e.proof_id = NEW.proof_id AND e.validation_status = 'COMMITTED'
        AND e.evidence_type = 'FULFILLMENT_CAPTURE' AND (e.content_type LIKE 'video/%' OR e.content_type LIKE 'image/%'))
      AND (EXISTS (SELECT 1 FROM attestations a JOIN proof_participants p
        ON p.proof_id = a.proof_id AND p.user_id = a.attested_by AND p.role = 'SELLER'
        WHERE a.proof_id = NEW.proof_id AND a.statement = 'PACKED_DESCRIBED_ITEM')
        OR (NEW.event_type = 'ATTESTATION_COMMITTED' AND NEW.event_data->>'statement' = 'PACKED_DESCRIBED_ITEM'
          AND EXISTS (SELECT 1 FROM proof_participants WHERE proof_id = NEW.proof_id AND user_id = NEW.actor_user_id AND role = 'SELLER')))
    THEN
      INSERT INTO proof_outbox(id, proof_id, audit_id, event_type, created_at)
      VALUES (NEW.proof_id || ':capture.completed', NEW.proof_id, NEW.id, 'capture.completed', NEW.created_at)
      ON CONFLICT (id) DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS proof_outbox_on_audit ON audit_events;
CREATE TRIGGER proof_outbox_on_audit AFTER INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION publish_proof_outbox();

CREATE OR REPLACE FUNCTION platform_record_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PLATFORM_RECORD_IMMUTABLE';
END;
$$;
DROP TRIGGER IF EXISTS tenant_proof_immutable ON api_tenant_proofs;
CREATE TRIGGER tenant_proof_immutable BEFORE UPDATE OR DELETE ON api_tenant_proofs FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
DROP TRIGGER IF EXISTS proof_outbox_immutable ON proof_outbox;
CREATE TRIGGER proof_outbox_immutable BEFORE UPDATE OR DELETE ON proof_outbox FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
DROP TRIGGER IF EXISTS api_audit_immutable ON api_request_audit;
CREATE TRIGGER api_audit_immutable BEFORE UPDATE OR DELETE ON api_request_audit FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
