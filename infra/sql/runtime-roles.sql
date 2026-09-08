-- Apply with psql as the database owner, in a reviewed migration/privilege window.
-- Non-login group roles. Provision separate login roles/managed secrets out of band.
-- Existing tables MUST be owned by the migration login, never an application login.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='packproof_runtime') THEN CREATE ROLE packproof_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='packproof_recovery') THEN CREATE ROLE packproof_recovery NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='packproof_backup') THEN CREATE ROLE packproof_backup NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='packproof_maintenance') THEN CREATE ROLE packproof_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO packproof_runtime,packproof_backup,packproof_maintenance,packproof_recovery;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO packproof_runtime;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO packproof_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO packproof_backup;
GRANT SELECT,UPDATE,DELETE ON http_rate_windows,operational_worker_heartbeats TO packproof_maintenance;
-- Guards still enforce state-specific committed immutability on mutable tables.
-- Schema owner role must be separate or ALTER/DISABLE TRIGGER would bypass them.
REVOKE ALL ON schema_migrations FROM packproof_runtime;
GRANT SELECT ON schema_migrations TO packproof_runtime;
REVOKE UPDATE,DELETE,TRUNCATE ON final_manifests,audit_events,recovery_events,proof_supplements,policy_recovery_events FROM packproof_runtime;
-- No default broad grants. Reapply this reviewed script after every migration;
-- inspect any new table's privilege scope before admitting runtime traffic.

-- Publisher authority can advance delivery receipts; ordinary API runtime cannot.
REVOKE UPDATE,DELETE,TRUNCATE ON recovery_delivery,policy_recovery_delivery FROM packproof_runtime;
GRANT SELECT,UPDATE ON recovery_delivery,policy_recovery_delivery TO packproof_recovery;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON recovery_writer_fence,policy_recovery_fence,policy_recovery_overlay,policy_recovery_tables FROM packproof_runtime;
-- Recovery takes a row lock on the writer fence; UPDATE permission permits the lock.
GRANT SELECT,UPDATE ON recovery_writer_fence TO packproof_recovery;
