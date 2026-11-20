CREATE TABLE record_order_packet_exports (
  id text PRIMARY KEY,
  proof_id text NOT NULL,
  revision integer NOT NULL,
  membership_id text NOT NULL REFERENCES platform_memberships(id),
  exported_at timestamptz NOT NULL,
  destination text NOT NULL,
  manifest jsonb NOT NULL,
  packet_sha256 text NOT NULL,
  FOREIGN KEY (proof_id, revision) REFERENCES record_order_revisions(proof_id, revision)
);
