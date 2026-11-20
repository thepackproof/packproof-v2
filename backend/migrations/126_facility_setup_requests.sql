CREATE TABLE record_setup_drafts (
  installation_id text NOT NULL REFERENCES record_agent_installations(id),
  draft_id uuid NOT NULL,
  requester_id text NOT NULL,
  latest_revision integer NOT NULL CHECK (latest_revision > 0),
  PRIMARY KEY (installation_id, draft_id, requester_id)
);

CREATE TABLE record_setup_requests (
  installation_id text NOT NULL,
  draft_id uuid NOT NULL,
  requester_id text NOT NULL,
  digest text NOT NULL,
  revision integer NOT NULL,
  created_at timestamptz NOT NULL,
  result jsonb,
  tokens integer,
  duration_ms integer,
  outcome text NOT NULL DEFAULT 'pending',
  PRIMARY KEY (installation_id, draft_id, requester_id, digest),
  FOREIGN KEY (installation_id, draft_id, requester_id)
    REFERENCES record_setup_drafts(installation_id, draft_id, requester_id) ON DELETE CASCADE
);
