-- Optional finite UI interactions and source build attribution in the existing opt-in study.
-- Legacy observations remain unchanged; no dataset or consent is created.
ALTER TABLE program_timing_events
  ADD COLUMN interaction TEXT CHECK (interaction IN ('order_selected','recording_started','recording_stopped','label_read','label_mismatch','review_opened','consent_confirmed','consent_cancelled','consent_failed','upload_pending','server_completed','recovery_started','share_created')),
  ADD COLUMN source_build_sha TEXT CHECK (source_build_sha ~ '^[a-f0-9]{40}$');

ALTER TABLE program_timing_events DROP CONSTRAINT program_timing_events_task_kind_check;
ALTER TABLE program_timing_events ADD CONSTRAINT program_timing_events_task_kind_check
  CHECK (task_kind IN ('packproof','ordinary_baseline','interface_action'));
