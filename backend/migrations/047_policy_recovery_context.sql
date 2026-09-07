-- Account policy may reference an unfinished Proof that has no accepted core
-- receipt yet. Preserve enough parent context to reconstruct those references;
-- this context deliberately does not claim media or core-event acceptance.
ALTER TABLE policy_recovery_events ADD COLUMN recovery_context JSONB;

CREATE FUNCTION policy_recovery_parent_context(source_row JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE proof_identity TEXT; proof_state JSONB; transaction_identity TEXT;
BEGIN
  proof_identity := source_row->>'proof_id';
  IF proof_identity IS NULL THEN RETURN NULL; END IF;
  SELECT to_jsonb(p) INTO proof_state FROM proofs p WHERE p.id=proof_identity;
  IF proof_state IS NULL THEN RETURN NULL; END IF;
  transaction_identity := proof_state->>'transaction_id';
  RETURN jsonb_build_object(
    'version',1,'domain','PACKPROOF_POLICY_PARENT_CONTEXT','coreAcceptance',false,'proofId',proof_identity,
    'rows',jsonb_build_object(
      'proofs',jsonb_build_array(proof_state),
      'transactions',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM transactions t WHERE id=transaction_identity),
      'transaction_shipping',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM transaction_shipping t WHERE transaction_id=transaction_identity),
      'transaction_items',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM transaction_items t WHERE transaction_id=transaction_identity),
      'transaction_integration_identities',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM transaction_integration_identities t WHERE transaction_id=transaction_identity)
    )
  );
END;
$$;
CREATE OR REPLACE FUNCTION append_policy_recovery_event(target_table TEXT, keys TEXT[], operation TEXT, old_row JSONB, new_row JSONB) RETURNS void LANGUAGE plpgsql AS $$
DECLARE before_state JSONB; after_state JSONB; identity JSONB := '{}'::jsonb; key_name TEXT; event_sequence BIGINT;
BEGIN
  before_state := policy_recovery_projection(target_table,old_row);
  after_state := policy_recovery_projection(target_table,new_row);
  IF before_state IS NOT DISTINCT FROM after_state THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(1347438146,43);
  FOREACH key_name IN ARRAY keys LOOP identity := identity || jsonb_build_object(key_name,COALESCE(new_row,old_row)->key_name); END LOOP;
  INSERT INTO policy_recovery_events(table_name,entity_key,operation,before_json,after_json,database_principal,transaction_id,recorded_at,recovery_context)
    VALUES(target_table,identity,operation,before_state,after_state,session_user,txid_current()::text,clock_timestamp(),policy_recovery_parent_context(COALESCE(new_row,old_row))) RETURNING sequence INTO event_sequence;
  INSERT INTO policy_recovery_delivery(sequence,next_attempt_at) VALUES(event_sequence,'1970-01-01T00:00:00Z');
END;
$$;
-- Add a new dated context baseline without modifying any older accepted event.
-- Lock all parent inputs and participants before reading the consistent snapshot.
DO $$
DECLARE target TEXT; source RECORD;
BEGIN
  FOREACH target IN ARRAY ARRAY['proof_participants','proofs','transaction_integration_identities','transaction_items','transaction_shipping','transactions'] LOOP
    EXECUTE format('LOCK TABLE %I IN SHARE ROW EXCLUSIVE MODE',target);
  END LOOP;
  FOR source IN SELECT to_jsonb(p) AS body FROM proof_participants p ORDER BY id LOOP
    PERFORM append_policy_recovery_event('proof_participants',ARRAY['id'],'BASELINE',NULL,source.body);
  END LOOP;
END;
$$;
