-- Claim delivery work before contacting SMTP. Expiring claims allow recovery
-- after a process exits; tokens prevent a stale worker acknowledging a new claim.
ALTER TABLE proof_notification_outbox ADD COLUMN delivery_token TEXT;
ALTER TABLE proof_notification_outbox ADD COLUMN delivery_lease_until TIMESTAMPTZ;
