-- Additive custody layer: workflow type, physical assets, observations,
-- transfers, continuity evaluations, and read-only Proof access links.
-- Existing commerce Proofs backfill to COMMERCE_SALE. Proof lifecycle
-- status is unchanged.

ALTER TABLE proofs
  ADD COLUMN workflow_type TEXT NOT NULL DEFAULT 'COMMERCE_SALE';

ALTER TABLE proofs
  ADD CONSTRAINT proofs_workflow_type_check CHECK (
    workflow_type IN ('COMMERCE_SALE', 'GRADING_SUBMISSION')
  );

ALTER TABLE evidence DROP CONSTRAINT evidence_type_check;
ALTER TABLE evidence
  ADD CONSTRAINT evidence_type_check CHECK (
    evidence_type IN (
      'SELLER_EVIDENCE',
      'FULFILLMENT_CAPTURE',
      'ASSET_CAPTURE',
      'PACKING_CAPTURE',
      'RECEIPT_CAPTURE'
    )
  );

CREATE FUNCTION reject_workflow_type_mutation()
RETURNS trigger AS $$
BEGIN
  IF NEW.workflow_type IS DISTINCT FROM OLD.workflow_type THEN
    RAISE EXCEPTION 'WORKFLOW_TYPE_IMMUTABLE'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER proofs_workflow_type_immutable
  BEFORE UPDATE ON proofs
  FOR EACH ROW
  EXECUTE PROCEDURE reject_workflow_type_mutation();

CREATE TABLE proof_assets (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs (id),
  asset_instance_id TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  catalog_descriptor JSONB NOT NULL DEFAULT '{}'::jsonb,
  label_index INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT proof_assets_instance_id_key UNIQUE (asset_instance_id),
  CONSTRAINT proof_assets_proof_label_key UNIQUE (proof_id, label_index),
  CONSTRAINT proof_assets_label_index_check CHECK (label_index > 0)
);

CREATE INDEX proof_assets_proof_idx
  ON proof_assets (proof_id, label_index);

CREATE TABLE proof_asset_external_refs (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs (id),
  asset_id TEXT REFERENCES proof_assets (id),
  transfer_id TEXT,
  tenant_key TEXT NOT NULL,
  external_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  source TEXT NOT NULL,
  supplied_by TEXT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT proof_asset_external_refs_scope_check CHECK (
    scope IN ('PROOF', 'ASSET', 'TRANSFER')
  ),
  CONSTRAINT proof_asset_external_refs_source_check CHECK (
    source IN ('PARTICIPANT_SUPPLIED', 'INTEGRATION')
  )
);

CREATE UNIQUE INDEX proof_asset_external_refs_asset_tenant_uq
  ON proof_asset_external_refs (asset_id, tenant_key)
  WHERE asset_id IS NOT NULL;

CREATE UNIQUE INDEX proof_asset_external_refs_transfer_tenant_uq
  ON proof_asset_external_refs (transfer_id, tenant_key)
  WHERE transfer_id IS NOT NULL AND scope = 'TRANSFER';

CREATE UNIQUE INDEX proof_asset_external_refs_tenant_ext_uq
  ON proof_asset_external_refs (tenant_key, external_id);

CREATE INDEX proof_asset_external_refs_proof_idx
  ON proof_asset_external_refs (proof_id);

CREATE TABLE custody_observations (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs (id),
  observation_type TEXT NOT NULL,
  actor_participant_id TEXT REFERENCES proof_participants (id),
  external_actor TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  server_recorded_at TIMESTAMPTZ NOT NULL,
  previous_observation_id TEXT REFERENCES custody_observations (id),
  capture_recipe TEXT,
  idempotency_key TEXT,
  CONSTRAINT custody_observations_type_check CHECK (
    observation_type IN (
      'ORIGIN_CAPTURE',
      'PACKED',
      'RELEASED',
      'RECEIVED',
      'INTAKE_CAPTURE',
      'PROCESS_OUTPUT',
      'RETURN_PACKED',
      'FINAL_RECEIPT'
    )
  )
);

CREATE UNIQUE INDEX custody_observations_idempotency_uq
  ON custody_observations (proof_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX custody_observations_proof_idx
  ON custody_observations (proof_id, server_recorded_at, id);

CREATE TABLE observation_assets (
  observation_id TEXT NOT NULL REFERENCES custody_observations (id),
  asset_id TEXT NOT NULL REFERENCES proof_assets (id),
  PRIMARY KEY (observation_id, asset_id)
);

CREATE TABLE observation_evidence (
  observation_id TEXT NOT NULL REFERENCES custody_observations (id),
  evidence_id TEXT NOT NULL REFERENCES evidence (id),
  slot TEXT NOT NULL,
  PRIMARY KEY (observation_id, evidence_id)
);

CREATE TABLE observation_external_refs (
  observation_id TEXT NOT NULL REFERENCES custody_observations (id),
  tenant_key TEXT NOT NULL,
  external_id TEXT NOT NULL,
  PRIMARY KEY (observation_id, tenant_key, external_id)
);

CREATE TABLE custody_transfers (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs (id),
  from_observation_id TEXT NOT NULL REFERENCES custody_observations (id),
  to_observation_id TEXT REFERENCES custody_observations (id),
  transfer_type TEXT NOT NULL,
  status TEXT NOT NULL,
  carrier_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT custody_transfers_type_check CHECK (
    transfer_type IN ('SHIPMENT', 'HANDOFF', 'INTERNAL', 'UNKNOWN')
  ),
  CONSTRAINT custody_transfers_status_check CHECK (
    status IN ('OPEN', 'RECEIVED')
  )
);

CREATE UNIQUE INDEX custody_transfers_idempotency_uq
  ON custody_transfers (proof_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX custody_transfers_proof_idx
  ON custody_transfers (proof_id, created_at);

CREATE TABLE continuity_evaluations (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs (id),
  from_observation_id TEXT NOT NULL REFERENCES custody_observations (id),
  to_observation_id TEXT NOT NULL REFERENCES custody_observations (id),
  algorithm_version TEXT NOT NULL,
  result TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_pairs JSONB NOT NULL DEFAULT '[]'::jsonb,
  actor_participant_id TEXT REFERENCES proof_participants (id),
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT continuity_evaluations_result_check CHECK (
    result IN ('NOT_EVALUATED', 'CONSISTENT', 'INCONCLUSIVE', 'MATERIAL_DIFFERENCE')
  )
);

CREATE UNIQUE INDEX continuity_evaluations_version_uq
  ON continuity_evaluations (
    proof_id, from_observation_id, to_observation_id, algorithm_version
  );

CREATE UNIQUE INDEX continuity_evaluations_idempotency_uq
  ON continuity_evaluations (proof_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX continuity_evaluations_proof_idx
  ON continuity_evaluations (proof_id, created_at);

CREATE TABLE proof_access_links (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs (id),
  token_hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_by_participant_id TEXT NOT NULL REFERENCES proof_participants (id),
  recipient_hint TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ,
  view_count INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT proof_access_links_token_hash_key UNIQUE (token_hash),
  CONSTRAINT proof_access_links_scope_check CHECK (
    scope IN ('STATUS_ONLY', 'SUMMARY', 'EVIDENCE_VIEW')
  )
);

CREATE INDEX proof_access_links_proof_idx
  ON proof_access_links (proof_id, created_at);

CREATE FUNCTION reject_observation_join_cross_proof()
RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'observation_assets' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM custody_observations o
        JOIN proof_assets a ON a.id = NEW.asset_id
       WHERE o.id = NEW.observation_id
         AND a.proof_id = o.proof_id
    ) THEN
      RAISE EXCEPTION 'OBSERVATION_ASSET_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF TG_TABLE_NAME = 'observation_evidence' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM custody_observations o
        JOIN evidence e ON e.id = NEW.evidence_id
       WHERE o.id = NEW.observation_id
         AND e.proof_id = o.proof_id
         AND e.validation_status = 'COMMITTED'
    ) THEN
      RAISE EXCEPTION 'OBSERVATION_EVIDENCE_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER observation_assets_same_proof
  BEFORE INSERT ON observation_assets
  FOR EACH ROW
  EXECUTE PROCEDURE reject_observation_join_cross_proof();

CREATE TRIGGER observation_evidence_same_proof
  BEFORE INSERT ON observation_evidence
  FOR EACH ROW
  EXECUTE PROCEDURE reject_observation_join_cross_proof();

CREATE FUNCTION reject_transfer_cross_proof()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM custody_observations
     WHERE id = NEW.from_observation_id AND proof_id = NEW.proof_id
  ) THEN
    RAISE EXCEPTION 'TRANSFER_PROOF_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.to_observation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM custody_observations
     WHERE id = NEW.to_observation_id AND proof_id = NEW.proof_id
  ) THEN
    RAISE EXCEPTION 'TRANSFER_PROOF_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER custody_transfers_same_proof
  BEFORE INSERT OR UPDATE ON custody_transfers
  FOR EACH ROW
  EXECUTE PROCEDURE reject_transfer_cross_proof();

CREATE FUNCTION reject_asset_binding_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ASSET_BINDING_IMMUTABLE'
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER proof_asset_external_refs_immutable_update
  BEFORE UPDATE ON proof_asset_external_refs
  FOR EACH ROW
  EXECUTE PROCEDURE reject_asset_binding_mutation();

CREATE TRIGGER proof_asset_external_refs_immutable_delete
  BEFORE DELETE ON proof_asset_external_refs
  FOR EACH ROW
  EXECUTE PROCEDURE reject_asset_binding_mutation();

CREATE FUNCTION reject_observation_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'OBSERVATION_IMMUTABLE'
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER custody_observations_immutable_update
  BEFORE UPDATE ON custody_observations
  FOR EACH ROW
  EXECUTE PROCEDURE reject_observation_mutation();

CREATE TRIGGER custody_observations_immutable_delete
  BEFORE DELETE ON custody_observations
  FOR EACH ROW
  EXECUTE PROCEDURE reject_observation_mutation();

CREATE TRIGGER observation_assets_immutable_update
  BEFORE UPDATE ON observation_assets
  FOR EACH ROW
  EXECUTE PROCEDURE reject_observation_mutation();

CREATE TRIGGER observation_assets_immutable_delete
  BEFORE DELETE ON observation_assets
  FOR EACH ROW
  EXECUTE PROCEDURE reject_observation_mutation();

CREATE TRIGGER observation_evidence_immutable_update
  BEFORE UPDATE ON observation_evidence
  FOR EACH ROW
  EXECUTE PROCEDURE reject_observation_mutation();

CREATE TRIGGER observation_evidence_immutable_delete
  BEFORE DELETE ON observation_evidence
  FOR EACH ROW
  EXECUTE PROCEDURE reject_observation_mutation();

CREATE FUNCTION reject_continuity_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CONTINUITY_IMMUTABLE'
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER continuity_evaluations_immutable_update
  BEFORE UPDATE ON continuity_evaluations
  FOR EACH ROW
  EXECUTE PROCEDURE reject_continuity_mutation();

CREATE TRIGGER continuity_evaluations_immutable_delete
  BEFORE DELETE ON continuity_evaluations
  FOR EACH ROW
  EXECUTE PROCEDURE reject_continuity_mutation();

ALTER TABLE proof_asset_external_refs
  ADD CONSTRAINT proof_asset_external_refs_transfer_fk
  FOREIGN KEY (transfer_id) REFERENCES custody_transfers (id);
