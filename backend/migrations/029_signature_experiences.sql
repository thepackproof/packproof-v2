-- Signature experiences are immutable supplements, never changes to the Proof core.
CREATE TABLE signature_snapshots (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  payload_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(proof_id,sha256),
  UNIQUE(id,proof_id)
);
CREATE TABLE evidence_anchors (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  payload_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  supersedes_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(proof_id,actor_user_id,idempotency_key),
  UNIQUE(id,proof_id),
  FOREIGN KEY(supersedes_id,proof_id) REFERENCES evidence_anchors(id,proof_id)
);
CREATE TABLE signature_cases (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  snapshot_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  payload_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(id,proof_id),
  FOREIGN KEY(snapshot_id,proof_id) REFERENCES signature_snapshots(id,proof_id)
);
CREATE TABLE signature_case_approvals (
  case_id TEXT PRIMARY KEY REFERENCES signature_cases(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  preview_sha256 TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE signature_comparisons (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  snapshot_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  outbound_anchor_id TEXT NOT NULL,
  inbound_anchor_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  supersedes_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(id,proof_id),
  FOREIGN KEY(snapshot_id,proof_id) REFERENCES signature_snapshots(id,proof_id),
  FOREIGN KEY(outbound_anchor_id,proof_id) REFERENCES evidence_anchors(id,proof_id),
  FOREIGN KEY(inbound_anchor_id,proof_id) REFERENCES evidence_anchors(id,proof_id),
  FOREIGN KEY(supersedes_id,proof_id) REFERENCES signature_comparisons(id,proof_id)
);
CREATE TABLE item_history_consents (
  id TEXT PRIMARY KEY,
  consent_sequence BIGSERIAL UNIQUE NOT NULL,
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  opted_in BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE item_history_graph_lock (id INTEGER PRIMARY KEY CHECK(id=1));
INSERT INTO item_history_graph_lock(id) VALUES(1);
CREATE INDEX item_history_consents_proof ON item_history_consents(proof_id,created_at,id);
CREATE TABLE item_history_links (
  id TEXT PRIMARY KEY,
  previous_proof_id TEXT NOT NULL REFERENCES proofs(id),
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  previous_asset_id TEXT NOT NULL REFERENCES proof_assets(id),
  asset_id TEXT NOT NULL REFERENCES proof_assets(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK(previous_proof_id<>proof_id),
  UNIQUE(previous_proof_id,proof_id,previous_asset_id,asset_id)
);
CREATE TABLE item_history_events (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES item_history_links(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  state TEXT NOT NULL CHECK(state IN ('CORROBORATED','DISPUTED','CORRECTED')),
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE signature_usage_daily (
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  feature TEXT NOT NULL CHECK(feature IN ('replay','ask','cases','compare','history')),
  usage_day DATE NOT NULL,
  requests BIGINT NOT NULL DEFAULT 0,
  failures BIGINT NOT NULL DEFAULT 0,
  processing_ms BIGINT NOT NULL DEFAULT 0,
  served_bytes BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY(proof_id,actor_user_id,feature,usage_day)
);
CREATE TABLE item_history_shares (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  recipient_user_id TEXT NOT NULL REFERENCES users(id),
  link_ids JSONB NOT NULL,
  approved_preview_sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE item_history_share_revocations (
  share_id TEXT PRIMARY KEY REFERENCES item_history_shares(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE OR REPLACE FUNCTION signature_supplement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SIGNATURE_SUPPLEMENT_IMMUTABLE';
END;
$$;
CREATE TRIGGER signature_snapshots_immutable BEFORE UPDATE OR DELETE ON signature_snapshots FOR EACH ROW EXECUTE FUNCTION signature_supplement_guard();
CREATE TRIGGER evidence_anchors_immutable BEFORE UPDATE OR DELETE ON evidence_anchors FOR EACH ROW EXECUTE FUNCTION signature_supplement_guard();
CREATE TRIGGER signature_cases_immutable BEFORE UPDATE OR DELETE ON signature_cases FOR EACH ROW EXECUTE FUNCTION signature_supplement_guard();
CREATE TRIGGER signature_approvals_immutable BEFORE UPDATE OR DELETE ON signature_case_approvals FOR EACH ROW EXECUTE FUNCTION signature_supplement_guard();
CREATE TRIGGER signature_comparisons_immutable BEFORE UPDATE OR DELETE ON signature_comparisons FOR EACH ROW EXECUTE FUNCTION signature_supplement_guard();
CREATE TRIGGER item_history_consents_immutable BEFORE UPDATE OR DELETE ON item_history_consents FOR EACH ROW EXECUTE FUNCTION signature_supplement_guard();
CREATE TRIGGER item_history_links_immutable BEFORE UPDATE OR DELETE ON item_history_links FOR EACH ROW EXECUTE FUNCTION signature_supplement_guard();
CREATE TRIGGER item_history_events_immutable BEFORE UPDATE OR DELETE ON item_history_events FOR EACH ROW EXECUTE FUNCTION signature_supplement_guard();
CREATE TRIGGER item_history_shares_immutable BEFORE UPDATE OR DELETE ON item_history_shares FOR EACH ROW EXECUTE FUNCTION signature_supplement_guard();
CREATE TRIGGER item_history_share_revocations_immutable BEFORE UPDATE OR DELETE ON item_history_share_revocations FOR EACH ROW EXECUTE FUNCTION signature_supplement_guard();
