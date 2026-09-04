-- Signature metadata is additive to the existing canonical-manifest SHA-256.
-- Existing finalized Proofs remain valid hash-only manifests. New manifests can
-- be signed by an asymmetric signer (production target: AWS KMS) without
-- changing canonical manifest v1 itself.
--
-- final_manifests has been UPDATE/DELETE immutable since migration 001. These
-- fields therefore must be supplied on the original INSERT. A signature can
-- never be attached, replaced, or repaired after finalization.

ALTER TABLE final_manifests
  ADD COLUMN signature_algorithm TEXT,
  ADD COLUMN signature_base64 TEXT,
  ADD COLUMN signing_key_id TEXT,
  ADD COLUMN signed_at TIMESTAMPTZ;

ALTER TABLE final_manifests
  ADD CONSTRAINT final_manifest_signature_all_or_none CHECK (
    (signature_algorithm IS NULL AND signature_base64 IS NULL AND signing_key_id IS NULL AND signed_at IS NULL)
    OR
    (signature_algorithm IS NOT NULL AND signature_base64 IS NOT NULL AND signing_key_id IS NOT NULL AND signed_at IS NOT NULL)
  );
