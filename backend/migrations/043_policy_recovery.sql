-- Account/tenant/disclosure changes need an ordered journal independent of a
-- single Proof. Freeze source facts in the originating transaction, including
-- direct service writes; canonical signing happens in the policy worker.
CREATE TABLE policy_recovery_events (
  sequence BIGSERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  entity_key JSONB NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('BASELINE','INSERT','UPDATE','DELETE')),
  before_json JSONB,
  after_json JSONB,
  database_principal TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER policy_recovery_events_immutable BEFORE UPDATE OR DELETE ON policy_recovery_events FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
CREATE TABLE policy_recovery_delivery (
  sequence BIGINT PRIMARY KEY REFERENCES policy_recovery_events(sequence),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','LEASED','DURABLE','DEAD_LETTER')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  error_code TEXT,
  event_sha256 TEXT,
  receipt_json JSONB
);
CREATE TABLE policy_recovery_fence (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  mode TEXT NOT NULL DEFAULT 'NORMAL' CHECK(mode IN ('NORMAL','RESTORING','RECONCILING')),
  durability_required BOOLEAN NOT NULL DEFAULT false,
  expected_sequence BIGINT,
  expected_head_sha256 TEXT,
  reconciled_sequence BIGINT,
  reconciled_head_sha256 TEXT,
  baseline_completed BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO policy_recovery_fence(singleton) VALUES(1);
CREATE TABLE policy_recovery_overlay (
  table_name TEXT NOT NULL,
  entity_key JSONB NOT NULL,
  desired_json JSONB,
  source_sequence BIGINT NOT NULL,
  PRIMARY KEY(table_name,entity_key)
);
CREATE TABLE policy_recovery_tables(table_name TEXT PRIMARY KEY,key_columns TEXT[] NOT NULL);
INSERT INTO policy_recovery_tables(table_name,key_columns) VALUES
  ('users',ARRAY['id']),('auth_identities',ARRAY['id']),('proof_participants',ARRAY['id']),
  ('invitations',ARRAY['id']),('commerce_receivers',ARRAY['proof_id']),
  ('api_tenants',ARRAY['id']),('api_keys',ARRAY['id']),('api_tenant_proofs',ARRAY['tenant_id','external_id']),
  ('proof_access_links',ARRAY['id']),('proof_disclosure_grants',ARRAY['access_link_id','scope_version']),
  ('proof_notification_subscriptions',ARRAY['id']),('proof_receipt_preferences',ARRAY['proof_id','user_id']),
  ('user_verified_contacts',ARRAY['user_id','email_normalized']),
  ('proof_retention_holds',ARRAY['id']),('proof_retention_assignments',ARRAY['id']),
  ('proof_disposition_state',ARRAY['proof_id']),('proof_media_derivatives',ARRAY['id']);
CREATE TRIGGER policy_recovery_tables_immutable BEFORE UPDATE OR DELETE ON policy_recovery_tables FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();

CREATE FUNCTION immutable_access_credential_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACCESS_CREDENTIAL_IMMUTABLE'; END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN RAISE EXCEPTION 'ACCESS_REVOCATION_IMMUTABLE'; END IF;
  IF TG_TABLE_NAME='api_keys' THEN
    IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at') THEN RAISE EXCEPTION 'ACCESS_CREDENTIAL_IMMUTABLE'; END IF;
  ELSIF (to_jsonb(NEW)-'revoked_at'-'last_accessed_at'-'view_count') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at'-'last_accessed_at'-'view_count') THEN
    RAISE EXCEPTION 'ACCESS_CREDENTIAL_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER access_link_credential_guard BEFORE UPDATE OR DELETE ON proof_access_links FOR EACH ROW EXECUTE PROCEDURE immutable_access_credential_identity();
CREATE TRIGGER api_key_credential_guard BEFORE UPDATE OR DELETE ON api_keys FOR EACH ROW EXECUTE PROCEDURE immutable_access_credential_identity();

CREATE FUNCTION policy_recovery_projection(table_name TEXT, payload JSONB) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF payload IS NULL THEN RETURN NULL; END IF;
  IF table_name='proof_access_links' THEN RETURN payload - 'view_count' - 'last_accessed_at'; END IF;
  IF table_name='proof_notification_subscriptions' THEN RETURN payload - 'processed_milestones' - 'updated_at'; END IF;
  IF table_name='users' THEN RETURN payload - 'updated_at'; END IF;
  IF table_name='auth_identities' THEN RETURN payload - 'last_refreshed_at'; END IF;
  IF table_name='proof_receipt_preferences' THEN RETURN payload - 'updated_at'; END IF;
  -- Pending invitation tokens are credentials. Restore missing tokens by issuing
  -- new invitations after reconciliation; never publish them in the journal.
  IF table_name='invitations' THEN RETURN payload - 'token'; END IF;
  RETURN payload;
END;
$$;
CREATE FUNCTION append_policy_recovery_event(target_table TEXT, keys TEXT[], operation TEXT, old_row JSONB, new_row JSONB) RETURNS void LANGUAGE plpgsql AS $$
DECLARE before_state JSONB; after_state JSONB; identity JSONB := '{}'::jsonb; key_name TEXT; event_sequence BIGINT;
BEGIN
  before_state := policy_recovery_projection(target_table,old_row);
  after_state := policy_recovery_projection(target_table,new_row);
  IF before_state IS NOT DISTINCT FROM after_state THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(1347438146,43);
  FOREACH key_name IN ARRAY keys LOOP identity := identity || jsonb_build_object(key_name,COALESCE(new_row,old_row)->key_name); END LOOP;
  INSERT INTO policy_recovery_events(table_name,entity_key,operation,before_json,after_json,database_principal,transaction_id,recorded_at)
    VALUES(target_table,identity,operation,before_state,after_state,session_user,txid_current()::text,clock_timestamp()) RETURNING sequence INTO event_sequence;
  INSERT INTO policy_recovery_delivery(sequence,next_attempt_at) VALUES(event_sequence,'1970-01-01T00:00:00Z');
END;
$$;
CREATE FUNCTION capture_policy_recovery_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE keys TEXT[];
BEGIN
  SELECT key_columns INTO keys FROM policy_recovery_tables WHERE table_name=TG_TABLE_NAME;
  PERFORM append_policy_recovery_event(TG_TABLE_NAME,keys,TG_OP,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END);
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
DO $$
DECLARE target RECORD; source RECORD;
BEGIN
  -- Hold all writer locks until migration commit so no policy mutation can land
  -- between a table's baseline snapshot and its change-capture trigger.
  FOR target IN SELECT * FROM policy_recovery_tables ORDER BY table_name LOOP
    EXECUTE format('LOCK TABLE %I IN SHARE ROW EXCLUSIVE MODE',target.table_name);
  END LOOP;
  FOR target IN SELECT * FROM policy_recovery_tables ORDER BY table_name LOOP
    FOR source IN EXECUTE format('SELECT to_jsonb(t) AS body FROM %I t',target.table_name) LOOP
      PERFORM append_policy_recovery_event(target.table_name,target.key_columns,'BASELINE',NULL,source.body);
    END LOOP;
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION capture_policy_recovery_change()',target.table_name || '_policy_recovery',target.table_name);
  END LOOP;
  UPDATE policy_recovery_fence SET baseline_completed=true WHERE singleton=1;
END;
$$;
