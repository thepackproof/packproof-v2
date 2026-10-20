-- Explicit organizational ownership is supplementary to the frozen Proof core.
CREATE TABLE platform_organizations (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('MERCHANT','PARTNER')),
 name TEXT NOT NULL, owner_user_id TEXT NOT NULL REFERENCES users(id),
 environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
 tenant_id TEXT UNIQUE REFERENCES api_tenants(id), enabled BOOLEAN NOT NULL DEFAULT false,
 created_at TIMESTAMPTZ NOT NULL, CHECK((kind='MERCHANT')=(tenant_id IS NOT NULL)),
 UNIQUE(id,environment)
);
CREATE TABLE platform_memberships (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES platform_organizations(id),
 user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('OWNER','ADMIN','OPERATOR','REVIEWER')),
 created_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ,
 UNIQUE(organization_id,user_id), UNIQUE(id,organization_id)
);
CREATE TABLE platform_principals (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES platform_organizations(id),
 actor_user_id TEXT NOT NULL UNIQUE REFERENCES users(id), name TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ,
 UNIQUE(id,organization_id)
);
CREATE TABLE platform_credentials (
 id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES platform_principals(id),
 token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, scopes JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ
);
CREATE TABLE platform_delegations (
 id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, partner_id TEXT NOT NULL,
 environment TEXT NOT NULL, scopes JSONB NOT NULL, operator_ids JSONB NOT NULL,
 issued_by TEXT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ,
 policy_version TEXT NOT NULL DEFAULT 'packproof.authorization/v1',
 FOREIGN KEY(merchant_id,environment) REFERENCES platform_organizations(id,environment),
 FOREIGN KEY(partner_id,environment) REFERENCES platform_organizations(id,environment),
 CHECK(merchant_id<>partner_id), UNIQUE(id,merchant_id)
);
CREATE INDEX platform_delegations_partner ON platform_delegations(partner_id,merchant_id);
CREATE TABLE platform_integration_accounts (
 id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, environment TEXT NOT NULL,
 provider TEXT NOT NULL, external_account_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(merchant_id,environment) REFERENCES platform_organizations(id,environment),
 UNIQUE(environment,provider,external_account_id), UNIQUE(id,merchant_id,environment)
);
CREATE TABLE platform_proof_ownership (
 proof_id TEXT PRIMARY KEY REFERENCES proofs(id), merchant_id TEXT NOT NULL,
 environment TEXT NOT NULL, operator_membership_id TEXT NOT NULL REFERENCES platform_memberships(id),
 origin_principal_id TEXT NOT NULL REFERENCES platform_principals(id),
 origin_delegation_id TEXT, created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(merchant_id,environment) REFERENCES platform_organizations(id,environment),
 FOREIGN KEY(origin_delegation_id,merchant_id) REFERENCES platform_delegations(id,merchant_id),
 UNIQUE(proof_id,merchant_id,environment)
);
CREATE TABLE platform_external_bindings (
 merchant_id TEXT NOT NULL, environment TEXT NOT NULL, integration_account_id TEXT NOT NULL,
 resource_type TEXT NOT NULL CHECK(resource_type IN ('ORDER','PAYMENT','SHIPMENT','RETURN','CLAIM')),
 external_id TEXT NOT NULL, proof_id TEXT NOT NULL, snapshot_sha256 TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(merchant_id,environment,integration_account_id,resource_type,external_id),
 FOREIGN KEY(integration_account_id,merchant_id,environment) REFERENCES platform_integration_accounts(id,merchant_id,environment),
 FOREIGN KEY(proof_id,merchant_id,environment) REFERENCES platform_proof_ownership(proof_id,merchant_id,environment)
);
CREATE TABLE platform_action_audit (
 id TEXT PRIMARY KEY, merchant_id TEXT REFERENCES platform_organizations(id),
 actor_user_id TEXT REFERENCES users(id), principal_id TEXT REFERENCES platform_principals(id),
 credential_id TEXT REFERENCES platform_credentials(id), delegation_id TEXT REFERENCES platform_delegations(id),
 request_id TEXT NOT NULL, operation TEXT NOT NULL, resource_id TEXT,
 policy_version TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX platform_action_audit_merchant ON platform_action_audit(merchant_id,created_at,id);
CREATE TABLE platform_capture_authorizations (
 intent_id TEXT PRIMARY KEY REFERENCES capture_intents(id), proof_id TEXT NOT NULL,
 merchant_id TEXT NOT NULL, environment TEXT NOT NULL,
 credential_id TEXT NOT NULL REFERENCES platform_credentials(id), delegation_id TEXT,
 created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(proof_id,merchant_id,environment) REFERENCES platform_proof_ownership(proof_id,merchant_id,environment),
 FOREIGN KEY(delegation_id,merchant_id) REFERENCES platform_delegations(id,merchant_id)
);
CREATE TABLE platform_webhook_authorizations (
 webhook_id TEXT PRIMARY KEY REFERENCES api_webhooks(id), merchant_id TEXT NOT NULL REFERENCES platform_organizations(id),
 credential_id TEXT NOT NULL REFERENCES platform_credentials(id), delegation_id TEXT REFERENCES platform_delegations(id)
);
CREATE TRIGGER platform_proof_ownership_immutable BEFORE UPDATE OR DELETE ON platform_proof_ownership FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER platform_bindings_immutable BEFORE UPDATE OR DELETE ON platform_external_bindings FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER platform_audit_immutable BEFORE UPDATE OR DELETE ON platform_action_audit FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER platform_capture_auth_immutable BEFORE UPDATE OR DELETE ON platform_capture_authorizations FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
