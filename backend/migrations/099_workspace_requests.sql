CREATE TABLE record_workspace_requests (
 id TEXT PRIMARY KEY,
 actor_user_id TEXT NOT NULL REFERENCES users(id),
 organization_id TEXT NOT NULL,
 environment TEXT NOT NULL CHECK (environment IN ('sandbox','live')),
 business_name TEXT NOT NULL,
 region TEXT NOT NULL,
 time_zone TEXT NOT NULL,
 location_name TEXT,
 created_at TIMESTAMPTZ NOT NULL,
 UNIQUE (actor_user_id,environment),
 FOREIGN KEY (organization_id,environment) REFERENCES platform_organizations(id,environment)
);
