CREATE TABLE record_requirement_templates (
 template_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9999),
 organization_id TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
 definition JSONB NOT NULL, definition_sha256 TEXT NOT NULL CHECK(definition_sha256 ~ '^[a-f0-9]{64}$'),
 created_by TEXT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(template_id,version), FOREIGN KEY(organization_id,environment) REFERENCES platform_organizations(id,environment)
);
CREATE INDEX record_requirement_templates_scope ON record_requirement_templates(organization_id,environment,template_id,version DESC);
CREATE TABLE record_requirement_assignments (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), subject_id TEXT NOT NULL,
 template_id TEXT NOT NULL, template_version INTEGER NOT NULL, definition_sha256 TEXT NOT NULL,
 requirement_ids JSONB NOT NULL, actor_user_id TEXT NOT NULL REFERENCES users(id), reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(template_id,template_version) REFERENCES record_requirement_templates(template_id,version),
 UNIQUE(proof_id,subject_id,template_id,template_version)
);
CREATE TRIGGER record_requirement_templates_immutable BEFORE UPDATE OR DELETE ON record_requirement_templates FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER record_requirement_assignments_immutable BEFORE UPDATE OR DELETE ON record_requirement_assignments FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
INSERT INTO policy_recovery_tables(table_name,key_columns) VALUES('record_requirement_templates',ARRAY['template_id','version']);
CREATE TRIGGER record_requirement_templates_policy_recovery AFTER INSERT OR UPDATE OR DELETE ON record_requirement_templates FOR EACH ROW EXECUTE FUNCTION capture_policy_recovery_change();
