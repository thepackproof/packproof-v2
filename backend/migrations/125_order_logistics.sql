-- Existing receipts have no independently observed device clock. Their server
-- receipt time and the bytes of all published revisions remain unchanged.
ALTER TABLE record_order_receipts ADD COLUMN first_seen_at timestamptz;

-- The index also covers snapshots published by an older client. Authorization
-- and selection of the current revision are applied by the read query.
CREATE FUNCTION record_order_subjects(snapshot jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT COALESCE(jsonb_agg(DISTINCT subject), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object('id',r->>'id','namespace',r->>'namespace','type',r->>'type','sourceId',e->>'sourceId') subject
    FROM jsonb_array_elements(snapshot->'events') e
    CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(e->'entity') || COALESCE(e->'references','[]'::jsonb)) r
    WHERE r->>'type' IN ('order','pick','warehouse_order','package','shipment','tracking')
      AND (e->>'associationScope'='order'
        OR (e->>'associationScope'='shared' AND r=e->'entity' AND r->>'type'<>'order'))
    UNION ALL
    SELECT jsonb_build_object('id',alias,'namespace',e->'entity'->>'namespace','type','order','sourceId',e->>'sourceId')
    FROM jsonb_array_elements(snapshot->'events') e
    CROSS JOIN LATERAL (VALUES (e->'fields'->>'orderReference'),
      (CASE WHEN e->'fieldLineage' ? 'sourceOrderName' THEN e->'fields'->>'sourceOrderName' END)) labels(alias)
    WHERE e->>'kind'='order' AND e->>'associationScope'='order' AND length(alias) BETWEEN 1 AND 200
  ) subjects
$$;
CREATE INDEX record_order_subject_lookup ON record_order_revisions USING gin (record_order_subjects(view) jsonb_path_ops);

CREATE TABLE record_order_original_access (
  installation_id text NOT NULL REFERENCES record_agent_installations(id),
  membership_id text NOT NULL REFERENCES platform_memberships(id),
  allowed boolean NOT NULL,
  reason text NOT NULL,
  decided_by text NOT NULL REFERENCES users(id),
  decided_at timestamptz NOT NULL,
  PRIMARY KEY (installation_id, membership_id)
);

CREATE TABLE record_order_case_actions (
  id text PRIMARY KEY,
  proof_id text NOT NULL REFERENCES record_order_roots(proof_id),
  case_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  proof_revision integer NOT NULL,
  action text NOT NULL CHECK (action IN ('assign','request_receipt','clarify_mapping','resolve')),
  owner_membership_id text REFERENCES platform_memberships(id),
  actor_user_id text NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(proof_id,case_key,version),
  FOREIGN KEY(proof_id,proof_revision) REFERENCES record_order_revisions(proof_id,revision)
);
CREATE TRIGGER order_case_action_immutable BEFORE UPDATE OR DELETE ON record_order_case_actions FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
