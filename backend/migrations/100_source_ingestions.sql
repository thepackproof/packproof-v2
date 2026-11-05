-- A source receipt is not a second shipping record. It is durable acceptance
-- evidence and work tracking for the existing canonical shipment event service.
CREATE TABLE record_ingestion_operations (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, environment TEXT NOT NULL,
 connection_id TEXT NOT NULL, connection_revision BIGINT NOT NULL CHECK(connection_revision>=0), principal_id TEXT NOT NULL REFERENCES platform_principals(id),
 credential_id TEXT NOT NULL REFERENCES platform_credentials(id), delegation_id TEXT REFERENCES platform_delegations(id),
 actor_context JSONB NOT NULL, request_id TEXT NOT NULL, received_at TIMESTAMPTZ NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','partially_succeeded','failed')),
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 lease_token TEXT, lease_expires_at TIMESTAMPTZ,
 FOREIGN KEY(connection_id,organization_id,environment) REFERENCES platform_integration_accounts(id,merchant_id,environment),
 UNIQUE(id,organization_id,environment,connection_id)
);
CREATE INDEX record_ingestion_pending ON record_ingestion_operations(state,next_attempt_at,lease_expires_at,received_at);
CREATE TABLE record_source_receipts (
 id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, item_index INTEGER NOT NULL CHECK(item_index BETWEEN 0 AND 99),
 organization_id TEXT NOT NULL, environment TEXT NOT NULL, connection_id TEXT NOT NULL,
 source_event_id TEXT NOT NULL, proof_id TEXT NOT NULL, reported_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL,
 payload_canonical TEXT NOT NULL, payload_sha256 TEXT NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'), normalized JSONB NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','imported','duplicate','conflict','failed')),
 canonical_event_id TEXT REFERENCES shipment_events(id), duplicate_of TEXT REFERENCES record_source_receipts(id), error_code TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 FOREIGN KEY(operation_id,organization_id,environment,connection_id) REFERENCES record_ingestion_operations(id,organization_id,environment,connection_id),
 FOREIGN KEY(proof_id,organization_id,environment) REFERENCES platform_proof_ownership(proof_id,merchant_id,environment),
 UNIQUE(operation_id,item_index), UNIQUE(id,organization_id,environment,connection_id)
);
CREATE INDEX record_source_receipts_operation ON record_source_receipts(operation_id,item_index);
CREATE TABLE record_source_identities (
 organization_id TEXT NOT NULL, environment TEXT NOT NULL, connection_id TEXT NOT NULL, source_event_id TEXT NOT NULL,
 receipt_id TEXT NOT NULL, payload_sha256 TEXT NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(organization_id,environment,connection_id,source_event_id),
 FOREIGN KEY(receipt_id,organization_id,environment,connection_id) REFERENCES record_source_receipts(id,organization_id,environment,connection_id)
);
CREATE TRIGGER record_source_identities_immutable BEFORE UPDATE OR DELETE ON record_source_identities FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE FUNCTION preserve_record_ingestion_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Source ingestion receipts are immutable'; END IF;
 IF TG_TABLE_NAME='record_source_receipts' THEN
  IF ROW(NEW.id,NEW.operation_id,NEW.item_index,NEW.organization_id,NEW.environment,NEW.connection_id,NEW.source_event_id,NEW.proof_id,NEW.reported_at,NEW.received_at,NEW.payload_canonical,NEW.payload_sha256,NEW.normalized,NEW.duplicate_of)
   IS DISTINCT FROM ROW(OLD.id,OLD.operation_id,OLD.item_index,OLD.organization_id,OLD.environment,OLD.connection_id,OLD.source_event_id,OLD.proof_id,OLD.reported_at,OLD.received_at,OLD.payload_canonical,OLD.payload_sha256,OLD.normalized,OLD.duplicate_of)
   THEN RAISE EXCEPTION 'Source ingestion receipt bytes and attribution are immutable'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.organization_id,NEW.environment,NEW.connection_id,NEW.connection_revision,NEW.principal_id,NEW.credential_id,NEW.delegation_id,NEW.actor_context,NEW.request_id,NEW.received_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.environment,OLD.connection_id,OLD.connection_revision,OLD.principal_id,OLD.credential_id,OLD.delegation_id,OLD.actor_context,OLD.request_id,OLD.received_at)
   THEN RAISE EXCEPTION 'Source ingestion operation attribution is immutable'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER record_ingestion_origin_immutable BEFORE UPDATE OR DELETE ON record_ingestion_operations FOR EACH ROW EXECUTE FUNCTION preserve_record_ingestion_source();
CREATE TRIGGER record_source_receipt_immutable BEFORE UPDATE OR DELETE ON record_source_receipts FOR EACH ROW EXECUTE FUNCTION preserve_record_ingestion_source();
