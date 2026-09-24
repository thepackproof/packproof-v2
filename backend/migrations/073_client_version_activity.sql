-- Minimized operational release telemetry. One latest observation per account
-- and declared surface; never a device inventory or evidence-integrity assertion.
CREATE TABLE client_version_activity (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK(platform IN ('ANDROID','IOS','WEB')),
  app_version TEXT,
  build TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(user_id,platform),
  CHECK(app_version IS NOT NULL OR build IS NOT NULL),
  CHECK(app_version IS NULL OR length(app_version) BETWEEN 1 AND 48),
  CHECK(build IS NULL OR length(build) BETWEEN 1 AND 64),
  CHECK(first_seen_at<=last_seen_at)
);
CREATE INDEX client_version_activity_recent ON client_version_activity(last_seen_at DESC,platform);
