-- Extend the existing independent access-policy journal. No bearer secret or
-- credential replay response is copied into this journal.
INSERT INTO policy_recovery_tables(table_name,key_columns) VALUES
 ('platform_organizations',ARRAY['id']),('platform_memberships',ARRAY['id']),
 ('platform_principals',ARRAY['id']),('platform_credentials',ARRAY['id']),
 ('platform_delegations',ARRAY['id']),('platform_integration_accounts',ARRAY['id']),
 ('platform_proof_ownership',ARRAY['proof_id']),
 ('platform_external_bindings',ARRAY['merchant_id','environment','integration_account_id','resource_type','external_id']);
ALTER FUNCTION policy_recovery_projection(TEXT,JSONB) RENAME TO legacy_policy_recovery_projection;
CREATE FUNCTION policy_recovery_projection(table_name TEXT,payload JSONB) RETURNS JSONB LANGUAGE SQL IMMUTABLE AS $$
 SELECT CASE WHEN table_name='platform_credentials' THEN payload-'last_used_at'
 ELSE legacy_policy_recovery_projection(table_name,payload) END
$$;
DO $$
DECLARE target RECORD; source RECORD;
BEGIN
 FOR target IN SELECT * FROM policy_recovery_tables WHERE left(table_name,9)='platform_' ORDER BY table_name LOOP
  EXECUTE format('LOCK TABLE %I IN SHARE ROW EXCLUSIVE MODE',target.table_name);
 END LOOP;
 FOR target IN SELECT * FROM policy_recovery_tables WHERE left(table_name,9)='platform_' ORDER BY table_name LOOP
  FOR source IN EXECUTE format('SELECT to_jsonb(t) AS body FROM %I t',target.table_name) LOOP
   PERFORM append_policy_recovery_event(target.table_name,target.key_columns,'BASELINE',NULL,source.body);
  END LOOP;
  EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION capture_policy_recovery_change()',target.table_name||'_policy_recovery',target.table_name);
 END LOOP;
END;
$$;
CREATE FUNCTION immutable_organization_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ORGANIZATION_AUTHORITY_IMMUTABLE'; END IF;
 IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN RAISE EXCEPTION 'ORGANIZATION_REVOCATION_IMMUTABLE'; END IF;
 IF (to_jsonb(NEW)-'revoked_at'-'last_used_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at'-'last_used_at') THEN RAISE EXCEPTION 'ORGANIZATION_AUTHORITY_IMMUTABLE'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER platform_credentials_identity BEFORE UPDATE OR DELETE ON platform_credentials FOR EACH ROW EXECUTE FUNCTION immutable_organization_authority();
CREATE TRIGGER platform_memberships_identity BEFORE UPDATE OR DELETE ON platform_memberships FOR EACH ROW EXECUTE FUNCTION immutable_organization_authority();
CREATE TRIGGER platform_principals_identity BEFORE UPDATE OR DELETE ON platform_principals FOR EACH ROW EXECUTE FUNCTION immutable_organization_authority();
CREATE TRIGGER platform_delegations_identity BEFORE UPDATE OR DELETE ON platform_delegations FOR EACH ROW EXECUTE FUNCTION immutable_organization_authority();
