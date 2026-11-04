-- Operational projections extend canonical Proof identity. Historical media,
-- manifests and attestations are never rewritten by these tables.
ALTER TABLE platform_proof_ownership ALTER COLUMN origin_principal_id DROP NOT NULL;
ALTER TABLE platform_proof_ownership ADD COLUMN origin_user_id TEXT REFERENCES users(id);
ALTER TABLE platform_proof_ownership ADD CONSTRAINT platform_proof_origin_present CHECK(origin_principal_id IS NOT NULL OR origin_user_id IS NOT NULL);
ALTER TABLE platform_memberships ADD COLUMN location_scoped BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE record_locations (
 id TEXT NOT NULL, organization_id TEXT NOT NULL REFERENCES platform_organizations(id), name TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(id,organization_id)
);
CREATE TABLE record_membership_locations (
 membership_id TEXT NOT NULL, organization_id TEXT NOT NULL, location_id TEXT NOT NULL,
 PRIMARY KEY(membership_id,location_id),
 FOREIGN KEY(membership_id,organization_id) REFERENCES platform_memberships(id,organization_id),
 FOREIGN KEY(location_id,organization_id) REFERENCES record_locations(id,organization_id)
);
CREATE TABLE record_state (
 proof_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, environment TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), lifecycle TEXT NOT NULL DEFAULT 'open' CHECK(lifecycle IN ('open','closed')),
 review_state TEXT NOT NULL DEFAULT 'unreviewed' CHECK(review_state IN ('unreviewed','reviewed')),
 title TEXT, reference TEXT, location_id TEXT, updated_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(proof_id,organization_id,environment) REFERENCES platform_proof_ownership(proof_id,merchant_id,environment),
 FOREIGN KEY(location_id,organization_id) REFERENCES record_locations(id,organization_id)
);
CREATE INDEX records_workspace_updated ON record_state(organization_id,environment,updated_at DESC,proof_id DESC);
CREATE TABLE record_entities (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), kind TEXT NOT NULL CHECK(kind IN ('shipment','stop','package','pallet','item','return')),
 external_reference TEXT, parent_id TEXT REFERENCES record_entities(id), attributes JSONB NOT NULL, actor_user_id TEXT NOT NULL REFERENCES users(id),
 supersedes_id TEXT REFERENCES record_entities(id), created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX record_entities_proof ON record_entities(proof_id,created_at,id);
CREATE TABLE record_evidence_links (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), evidence_id TEXT NOT NULL REFERENCES evidence(id),
 subject_id TEXT NOT NULL, reason TEXT NOT NULL, actor_user_id TEXT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL,
 UNIQUE(proof_id,evidence_id,subject_id)
);
CREATE TABLE record_requirements (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), subject_id TEXT NOT NULL, stage TEXT NOT NULL, title TEXT NOT NULL,
 template_version TEXT NOT NULL, accepted_evidence_types JSONB NOT NULL, due_at TIMESTAMPTZ,
 grace_period_ms INTEGER NOT NULL DEFAULT 0 CHECK(grace_period_ms>=0 AND grace_period_ms<=2592000000), created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX record_requirements_proof ON record_requirements(proof_id,id);
CREATE TABLE record_requirement_waivers (
 id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL UNIQUE REFERENCES record_requirements(id), reason TEXT NOT NULL,
 actor_user_id TEXT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE record_issues (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), category TEXT NOT NULL,
 severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical')), title TEXT NOT NULL, subject_id TEXT NOT NULL,
 rule_version TEXT NOT NULL, compared_sources JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX record_issues_proof ON record_issues(proof_id,created_at,id);
CREATE TABLE record_issue_actions (
 id TEXT PRIMARY KEY, sequence BIGSERIAL UNIQUE, issue_id TEXT NOT NULL REFERENCES record_issues(id), action TEXT NOT NULL CHECK(action IN ('acknowledge','resolve','reopen','note')),
 reason TEXT NOT NULL, actor_user_id TEXT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX record_issue_actions_order ON record_issue_actions(issue_id,sequence DESC);
CREATE TABLE record_amendments (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), supersedes_id TEXT NOT NULL,
 assertion JSONB NOT NULL, reason TEXT NOT NULL, actor_user_id TEXT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE record_command_results (
 organization_id TEXT NOT NULL REFERENCES platform_organizations(id), environment TEXT NOT NULL,
 actor_id TEXT NOT NULL, operation TEXT NOT NULL, key_hash TEXT NOT NULL, request_hash TEXT NOT NULL,
 response JSONB, created_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(organization_id,environment,actor_id,operation,key_hash)
);
CREATE TRIGGER record_entities_immutable BEFORE UPDATE OR DELETE ON record_entities FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER record_evidence_links_immutable BEFORE UPDATE OR DELETE ON record_evidence_links FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER record_requirements_immutable BEFORE UPDATE OR DELETE ON record_requirements FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER record_requirement_waivers_immutable BEFORE UPDATE OR DELETE ON record_requirement_waivers FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER record_issues_immutable BEFORE UPDATE OR DELETE ON record_issues FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER record_issue_actions_immutable BEFORE UPDATE OR DELETE ON record_issue_actions FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER record_amendments_immutable BEFORE UPDATE OR DELETE ON record_amendments FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
-- Location authorization survives independent access-policy recovery.
INSERT INTO policy_recovery_tables(table_name,key_columns) VALUES
 ('record_locations',ARRAY['id','organization_id']),
 ('record_membership_locations',ARRAY['membership_id','location_id']),('record_state',ARRAY['proof_id']);
CREATE TRIGGER record_locations_policy_recovery AFTER INSERT OR UPDATE OR DELETE ON record_locations FOR EACH ROW EXECUTE FUNCTION capture_policy_recovery_change();
CREATE TRIGGER record_membership_locations_policy_recovery AFTER INSERT OR UPDATE OR DELETE ON record_membership_locations FOR EACH ROW EXECUTE FUNCTION capture_policy_recovery_change();
CREATE TRIGGER record_state_policy_recovery AFTER INSERT OR UPDATE OR DELETE ON record_state FOR EACH ROW EXECUTE FUNCTION capture_policy_recovery_change();
-- Enforce site restrictions on existing participant collections and capture/read
-- routes as well as the new records portal. Independent buyer/receiver authority
-- is unaffected: the predicate applies only to the assigned organization operator.
ALTER FUNCTION platform_operator_access_active(TEXT,TEXT) RENAME TO pre_records_operator_access_active;
CREATE FUNCTION platform_operator_access_active(target_proof TEXT,target_user TEXT)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 SELECT pre_records_operator_access_active(target_proof,target_user) AND NOT EXISTS (
   SELECT 1 FROM platform_proof_ownership b JOIN platform_memberships m ON m.id=b.operator_membership_id
   LEFT JOIN record_state rs ON rs.proof_id=b.proof_id
   WHERE b.proof_id=target_proof AND m.user_id=target_user AND (
     (m.location_scoped AND (rs.location_id IS NULL OR NOT EXISTS(SELECT 1 FROM record_membership_locations g
       WHERE g.membership_id=m.id AND g.organization_id=b.merchant_id AND g.location_id=rs.location_id)))
     OR (m.organization_id<>b.merchant_id AND rs.location_id IS NOT NULL)
   )
 )
$$;
