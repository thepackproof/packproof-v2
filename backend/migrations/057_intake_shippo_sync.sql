-- Private API source retention. No client routes expose these bytes.
CREATE TABLE intake_provider_raw_sources (
  id text PRIMARY KEY,
  actor_user_id text NOT NULL REFERENCES users(id),
  connection_id text NOT NULL REFERENCES integration_connections(id),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  source_bytes bytea NOT NULL CHECK(octet_length(source_bytes)<=2000000),
  received_at timestamptz NOT NULL,
  UNIQUE(connection_id,sha256)
);
CREATE TRIGGER intake_provider_raw_sources_immutable BEFORE UPDATE OR DELETE
  ON intake_provider_raw_sources FOR EACH ROW EXECUTE FUNCTION protect_intake_immutable();
