CREATE TABLE record_order_source_health (
  session_id text NOT NULL REFERENCES record_order_sessions(id),
  source_id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  checked_at timestamptz NOT NULL,
  verified_read_at timestamptz,
  received_at timestamptz NOT NULL,
  state text NOT NULL CHECK(state IN ('current','unreadable')),
  PRIMARY KEY (session_id,source_id,generation)
);
