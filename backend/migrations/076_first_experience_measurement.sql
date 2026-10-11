-- Extend the existing opt-in dataset only. No grant, dataset, account mapping,
-- or collection is enabled by this migration. Old clients remain compatible.
ALTER TABLE program_timing_events DROP CONSTRAINT program_timing_events_interaction_check;
ALTER TABLE program_timing_events ADD CONSTRAINT program_timing_events_interaction_check CHECK (interaction IN (
 'order_selected','recording_started','recording_stopped','label_read','label_mismatch','review_opened','consent_confirmed','consent_cancelled','consent_failed','upload_pending','server_completed','recovery_started','share_created',
 'entry_viewed','start_selected','auth_started','auth_completed','auth_failed','capture_ready','capture_started','capture_saved','capture_interrupted','submission_authorized','upload_state_changed','help_opened','hint_dismissed','recovery_action'
));
ALTER TABLE program_timing_events
 ADD COLUMN flow_version INTEGER CHECK(flow_version=1),
 ADD COLUMN app_version TEXT CHECK(app_version ~ '^[0-9][a-zA-Z0-9._-]{0,63}$'),
 ADD COLUMN platform TEXT CHECK(platform IN ('android','ios','web','desktop')),
 ADD COLUMN entry_source TEXT CHECK(entry_source IN ('home','manual','order','deep_link','recovery','sample','help','auth','unknown')),
 ADD COLUMN client_occurred_at TIMESTAMPTZ,
 ADD COLUMN network_state TEXT CHECK(network_state IN ('online','offline','unknown')),
 ADD COLUMN upload_state TEXT CHECK(upload_state IN ('queued','uploading','waiting','retrying','committing','finalizing','complete','needs_attention'));
CREATE INDEX program_first_experience_starts ON program_timing_events(dataset_ref,client_started_at,merchant_ref) WHERE interaction='start_selected' AND flow_version=1;
