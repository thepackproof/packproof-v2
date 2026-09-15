-- Persist cursor-loop protection across worker page budgets, crashes and retries.
-- Completed windows clear these operational hashes; raw provider cursors remain private.
CREATE TABLE commerce_sync_page_checkpoints (
  connection_id text NOT NULL REFERENCES integration_connections(id),
  cursor_sha256 text NOT NULL,
  PRIMARY KEY(connection_id,cursor_sha256)
);
-- Webhook identity is provider + stable account + delivery, not globally delivery alone.
-- Existing uniqueness remains for old binaries; new code namespaces delivery IDs.
