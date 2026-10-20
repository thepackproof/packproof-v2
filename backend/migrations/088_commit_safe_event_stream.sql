-- Additive stream. The legacy BIGSERIAL cursor remains unchanged.
-- The counter update is transactional: a later writer for this tenant cannot
-- publish a higher position until the earlier writer commits or rolls back.
CREATE TABLE api_event_stream_heads (
  tenant_id TEXT PRIMARY KEY REFERENCES api_tenants(id),
  position BIGINT NOT NULL DEFAULT 0 CHECK(position >= 0),
  floor_position BIGINT NOT NULL DEFAULT 0 CHECK(floor_position >= 0 AND floor_position <= position)
);
CREATE TABLE api_event_stream (
  tenant_id TEXT NOT NULL REFERENCES api_tenants(id),
  position BIGINT NOT NULL CHECK(position > 0),
  event_id TEXT NOT NULL REFERENCES proof_outbox(id),
  PRIMARY KEY(tenant_id, position),
  UNIQUE(tenant_id, event_id)
);
CREATE FUNCTION append_api_stream_event(target_tenant TEXT, target_event TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE next_position BIGINT;
BEGIN
  INSERT INTO api_event_stream_heads(tenant_id) VALUES(target_tenant) ON CONFLICT DO NOTHING;
  -- Lock before checking uniqueness, including retries from the binding trigger.
  PERFORM 1 FROM api_event_stream_heads WHERE tenant_id=target_tenant FOR UPDATE;
  IF EXISTS(SELECT 1 FROM api_event_stream WHERE tenant_id=target_tenant AND event_id=target_event) THEN RETURN; END IF;
  UPDATE api_event_stream_heads SET position=position+1 WHERE tenant_id=target_tenant RETURNING position INTO next_position;
  INSERT INTO api_event_stream(tenant_id,position,event_id) VALUES(target_tenant,next_position,target_event);
END;
$$;
CREATE FUNCTION stream_new_proof_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant TEXT;
BEGIN
  SELECT tenant_id INTO tenant FROM api_tenant_proofs WHERE proof_id=NEW.proof_id;
  IF tenant IS NOT NULL THEN PERFORM append_api_stream_event(tenant,NEW.id); END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION stream_new_tenant_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event RECORD;
BEGIN
  -- Creation emits its audit before the tenant binding exists. Publish those
  -- events in the same transaction as binding; never infer ownership from ids.
  FOR event IN SELECT id FROM proof_outbox WHERE proof_id=NEW.proof_id ORDER BY sequence LOOP
    PERFORM append_api_stream_event(NEW.tenant_id,event.id);
  END LOOP;
  RETURN NEW;
END;
$$;
-- Block writers while backfilling, so no event can fall between scan and trigger.
LOCK TABLE api_tenant_proofs, proof_outbox IN SHARE ROW EXCLUSIVE MODE;
CREATE CONSTRAINT TRIGGER api_stream_on_outbox AFTER INSERT ON proof_outbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stream_new_proof_outbox();
CREATE CONSTRAINT TRIGGER api_stream_on_binding AFTER INSERT ON api_tenant_proofs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stream_new_tenant_binding();
DO $$
DECLARE event RECORD;
BEGIN
  FOR event IN SELECT p.tenant_id,o.id FROM api_tenant_proofs p JOIN proof_outbox o ON o.proof_id=p.proof_id ORDER BY p.tenant_id,o.sequence LOOP
    PERFORM append_api_stream_event(event.tenant_id,event.id);
  END LOOP;
END;
$$;
CREATE TRIGGER api_event_stream_immutable BEFORE UPDATE OR DELETE ON api_event_stream FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
