-- Shared application quotas; contains only a digest of the public client ID.
CREATE TABLE etsy_request_budget (
  client_hash TEXT PRIMARY KEY,
  next_request_at TIMESTAMPTZ NOT NULL,
  blocked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE etsy_request_usage (
  client_hash TEXT NOT NULL REFERENCES etsy_request_budget(client_hash),
  minute_start TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (client_hash, minute_start)
);
