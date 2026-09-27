-- Admin aggregates share the existing source-of-truth tables. These indexes also
-- support ordinary account/proof navigation. No duplicate event history is made.
CREATE INDEX users_created_admin ON users(created_at DESC,id);
CREATE INDEX proofs_created_admin ON proofs(created_at DESC,id);
CREATE INDEX proofs_finalized_admin ON proofs(finalized_at DESC) WHERE finalized_at IS NOT NULL;
CREATE INDEX evidence_created_admin ON evidence(created_at DESC,id);
CREATE INDEX evidence_committed_admin ON evidence(committed_at DESC) WHERE committed_at IS NOT NULL;
CREATE INDEX stage_evidence_created_admin ON commerce_stage_evidence(created_at DESC,id);
CREATE INDEX audit_events_activity_admin ON audit_events(created_at DESC,event_type);
CREATE INDEX audit_events_actor_activity_admin ON audit_events(actor_user_id,created_at DESC) WHERE actor_user_id IS NOT NULL;
CREATE INDEX account_audit_activity_admin ON account_audit_events(created_at DESC);
CREATE INDEX public_api_audit_created_admin ON api_request_audit(created_at DESC,status);
CREATE INDEX shipment_events_created_admin ON shipment_events(created_at DESC);
CREATE INDEX commerce_imports_created_admin ON commerce_order_records(first_seen_at DESC) WHERE transaction_id IS NOT NULL;
CREATE INDEX proof_links_created_admin ON proof_access_links(created_at DESC);
CREATE INDEX verified_contacts_email_admin ON user_verified_contacts(email_normalized,user_id);
CREATE INDEX transaction_shipping_tracking_admin ON transaction_shipping(tracking_number) WHERE tracking_number IS NOT NULL;
