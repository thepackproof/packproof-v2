ALTER TABLE users ADD COLUMN username TEXT;
ALTER TABLE users ADD COLUMN username_normalized TEXT;
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE';

ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('ACTIVE', 'DISABLED'));

CREATE UNIQUE INDEX users_username_normalized_uq
  ON users (username_normalized)
  WHERE username_normalized IS NOT NULL;
