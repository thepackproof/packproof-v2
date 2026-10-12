-- An immutable source is a Proof/evidence observation, not a globally unique blob.
-- Distinct recordings can produce identical luma frames and share content-addressed
-- storage. Keep each source ID/evidence ID and subject/Proof/tenant binding distinct.
-- Evidence-ID uniqueness, the composite subject foreign key, and immutability remain.
ALTER TABLE rnd_sources DROP CONSTRAINT rnd_sources_object_key_object_version_id_key;
