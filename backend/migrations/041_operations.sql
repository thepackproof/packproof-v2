-- Pseudonymous keys only; no request bodies, addresses, secrets or media in operational state.
CREATE TABLE operational_worker_heartbeats (
  worker_name TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  last_success_at TIMESTAMPTZ,
  state TEXT NOT NULL CHECK (state IN ('RUNNING','IDLE','ERROR')),
  PRIMARY KEY(worker_name,instance_id)
);
CREATE INDEX operational_worker_heartbeats_at ON operational_worker_heartbeats(heartbeat_at);
CREATE TABLE http_rate_windows (
  bucket_hash TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(bucket_hash,window_start)
);
CREATE INDEX http_rate_windows_expiry ON http_rate_windows(expires_at);
