CREATE TABLE platform_command_results (
 actor_user_id TEXT NOT NULL REFERENCES users(id), operation TEXT NOT NULL,
 key_hash TEXT NOT NULL, request_hash TEXT NOT NULL, response JSONB,
 created_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(actor_user_id,operation,key_hash)
);
