-- Bounded diagnostics for one authorized subscription; no change to delivery state.
CREATE INDEX IF NOT EXISTS webhook_deliveries_subscription_id ON api_webhook_deliveries(webhook_id,id);
CREATE INDEX IF NOT EXISTS api_webhooks_tenant_id ON api_webhooks(tenant_id,id);
