-- Additive optional barcode enrichment. Existing sessions/manifest bytes are untouched.
SET lock_timeout = '5s';
ALTER TABLE capture_sessions ADD COLUMN identifier_policy jsonb;
ALTER TABLE capture_sessions ADD CONSTRAINT capture_identifier_policy_valid CHECK(identifier_policy IS NULL OR
 (identifier_policy->>'version'='1' AND identifier_policy->>'surface' IN ('ANDROID','WEB')));
CREATE FUNCTION protect_capture_identifier_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.identifier_policy IS DISTINCT FROM NEW.identifier_policy THEN RAISE EXCEPTION 'IDENTIFIER_POLICY_IMMUTABLE'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER capture_identifier_policy_guard BEFORE UPDATE ON capture_sessions FOR EACH ROW EXECUTE FUNCTION protect_capture_identifier_policy();
CREATE UNIQUE INDEX capture_session_identifier_scope ON capture_sessions(id,proof_id,actor_user_id);
CREATE TABLE identifier_aliases (
 id text PRIMARY KEY, owner_user_id text NOT NULL REFERENCES users(id), tenant_key text NOT NULL, connection_id text NOT NULL,
 identifier_type text NOT NULL CHECK(identifier_type IN ('SKU','GTIN')), normalized_value text NOT NULL,
 source_ref text NOT NULL, source_revision text NOT NULL, snapshot_id text REFERENCES intake_order_snapshots(id),
 order_record_id text, transaction_id text, product_key text NOT NULL, product_json jsonb NOT NULL, observed_at timestamptz NOT NULL,
 UNIQUE(tenant_key,connection_id,identifier_type,normalized_value,source_ref)
);
CREATE INDEX identifier_alias_lookup ON identifier_aliases(owner_user_id,tenant_key,connection_id,identifier_type,normalized_value);
CREATE INDEX identifier_alias_source ON identifier_aliases(snapshot_id);
CREATE TABLE capture_identifier_observations (
 id text PRIMARY KEY, proof_id text NOT NULL, session_id text NOT NULL, actor_user_id text NOT NULL,
 client_event_id text NOT NULL, sequence integer NOT NULL CHECK(sequence>0), request_sha256 text NOT NULL,
 observation_json jsonb NOT NULL, resolution_json jsonb NOT NULL, supplemental boolean NOT NULL DEFAULT false, received_at timestamptz NOT NULL,
 FOREIGN KEY(session_id,proof_id,actor_user_id) REFERENCES capture_sessions(id,proof_id,actor_user_id),
 UNIQUE(session_id,client_event_id), UNIQUE(session_id,sequence), UNIQUE(id,session_id,proof_id)
);
CREATE TABLE capture_identifier_decisions (
 id text PRIMARY KEY, proof_id text NOT NULL, session_id text NOT NULL, actor_user_id text NOT NULL,
 observation_id text NOT NULL, client_event_id text NOT NULL, request_sha256 text NOT NULL, revision integer NOT NULL,
 decision text NOT NULL CHECK(decision IN ('NOT_THIS_SHIPMENT','ACKNOWLEDGE_MISMATCH')), reason text NOT NULL,
 supplemental boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL,
 FOREIGN KEY(session_id,proof_id,actor_user_id) REFERENCES capture_sessions(id,proof_id,actor_user_id),
 FOREIGN KEY(observation_id,session_id,proof_id) REFERENCES capture_identifier_observations(id,session_id,proof_id),
 UNIQUE(session_id,client_event_id), UNIQUE(observation_id)
);
CREATE TABLE capture_identifier_checkpoints (
 id text PRIMARY KEY, proof_id text NOT NULL, session_id text NOT NULL, actor_user_id text NOT NULL,
 client_event_id text NOT NULL, request_sha256 text NOT NULL, revision integer NOT NULL, last_sequence integer NOT NULL,
 coverage text NOT NULL CHECK(coverage IN ('COMPLETE','PARTIAL','UNAVAILABLE')), omitted_events integer NOT NULL CHECK(omitted_events>=0),
 canonical_json text NOT NULL, sha256 text NOT NULL, created_at timestamptz NOT NULL,
 FOREIGN KEY(session_id,proof_id,actor_user_id) REFERENCES capture_sessions(id,proof_id,actor_user_id), UNIQUE(session_id), UNIQUE(session_id,client_event_id)
);
CREATE FUNCTION protect_identifier_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IDENTIFIER_EVIDENCE_IMMUTABLE'; END; $$;
CREATE TRIGGER identifier_observations_immutable BEFORE UPDATE OR DELETE ON capture_identifier_observations FOR EACH ROW EXECUTE FUNCTION protect_identifier_evidence();
CREATE TRIGGER identifier_decisions_immutable BEFORE UPDATE OR DELETE ON capture_identifier_decisions FOR EACH ROW EXECUTE FUNCTION protect_identifier_evidence();
CREATE TRIGGER identifier_checkpoints_immutable BEFORE UPDATE OR DELETE ON capture_identifier_checkpoints FOR EACH ROW EXECUTE FUNCTION protect_identifier_evidence();
-- Rebuildable SKU index only from real connected API snapshots. GTINs are validated by the shared parser during import.
INSERT INTO identifier_aliases(id,owner_user_id,tenant_key,connection_id,identifier_type,normalized_value,source_ref,source_revision,snapshot_id,transaction_id,product_key,product_json,observed_at)
SELECT 'alias_'||md5(s.id||':'||i.ordinality::text||':SKU'),o.actor_user_id,o.tenant_key,o.connection_id,'SKU',i.item->>'sku',s.id||':'||i.ordinality::text,s.digest,s.id,s.transaction_id,
 CASE WHEN i.item->>'variantId' IS NOT NULL THEN 'variant:'||(i.item->>'variantId') WHEN i.item->>'productId' IS NOT NULL THEN 'product:'||(i.item->>'productId')||':'||COALESCE(i.item->>'variant','') ELSE 'descriptor:'||octet_length(COALESCE(i.item->>'title',''))::text||':'||COALESCE(i.item->>'title','')||'|'||octet_length(COALESCE(i.item->>'variant',''))::text||':'||COALESCE(i.item->>'variant','')||'|'||octet_length(COALESCE(i.item->>'sku',''))::text||':'||COALESCE(i.item->>'sku','')||'|0:' END,
 jsonb_build_object('title',i.item->>'title','variant',i.item->>'variant','sku',i.item->>'sku','gtin',NULL,'imageUrl',NULL,'externalItemId',i.item->>'externalItemId'),s.created_at
FROM intake_order_snapshots s JOIN intake_source_observations o ON o.id=s.observation_id JOIN integration_connections c ON c.id=o.connection_id AND c.owner_user_id=o.actor_user_id,
 LATERAL jsonb_array_elements(s.context->'items') WITH ORDINALITY i(item,ordinality)
WHERE o.source_kind='API_OBSERVED' AND c.adapter_key NOT LIKE 'demo%' AND NULLIF(i.item->>'sku','') IS NOT NULL ON CONFLICT DO NOTHING;
-- Existing verified commerce revisions can already supply exact SKUs even before
-- an intake snapshot is requested. No connector refresh is needed for this backfill.
INSERT INTO identifier_aliases(id,owner_user_id,tenant_key,connection_id,identifier_type,normalized_value,source_ref,source_revision,order_record_id,transaction_id,product_key,product_json,observed_at)
SELECT 'alias_commerce_'||md5(r.id||':'||i.ordinality::text||':SKU'),c.owner_user_id,o.commerce_tenant_key,r.connection_id,'SKU',i.item->>'sku',
 'commerce:'||o.id||':'||r.fingerprint||':'||i.ordinality::text,r.fingerprint,o.id,o.transaction_id,
 CASE WHEN i.item->>'variantId' IS NOT NULL THEN 'variant:'||(i.item->>'variantId') WHEN i.item->>'productId' IS NOT NULL THEN 'product:'||(i.item->>'productId')||':'||COALESCE(i.item->>'variant','') ELSE 'descriptor:'||octet_length(COALESCE(i.item->>'title',''))::text||':'||COALESCE(i.item->>'title','')||'|'||octet_length(COALESCE(i.item->>'variant',''))::text||':'||COALESCE(i.item->>'variant','')||'|'||octet_length(COALESCE(i.item->>'sku',''))::text||':'||COALESCE(i.item->>'sku','')||'|0:' END,
 jsonb_build_object('title',i.item->>'title','variant',i.item->>'variant','sku',i.item->>'sku','gtin',NULL,'imageUrl',NULL,'externalItemId',i.item->>'externalItemId'),r.observed_at
FROM commerce_order_revisions r JOIN commerce_order_records o ON o.id=r.order_record_id AND o.normalized_fingerprint=r.fingerprint
 JOIN integration_connections c ON c.id=r.connection_id,
 LATERAL jsonb_array_elements(r.normalized_order->'items') WITH ORDINALITY i(item,ordinality)
WHERE r.disposition<>'STALE' AND c.adapter_key NOT LIKE 'demo%' AND NULLIF(i.item->>'sku','') IS NOT NULL ON CONFLICT DO NOTHING;
RESET lock_timeout;
