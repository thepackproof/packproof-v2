-- Signature metadata is additive to the existing canonical-manifest SHA-256.
-- Existing finalized Proofs remain valid hash-only manifests. New manifests can
-- be signed by an asymmetric signer (production target: AWS KMS) without
-- changing canonical manifest v1 itself.

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

CREATE FUNCTION reject_manifest_signature_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.signature_base64 IS NOT NULL AND (
    NEW.signature_algorithm IS DISTINCT FROM OLD.signature_algorithm OR
    NEW.signature_base64 IS DISTINCT FROM OLD.signature_base64 OR
    NEW.signing_key_id IS DISTINCT FROM OLD.signing_key_id OR
    NEW.signed_at IS DISTINCT FROM OLD.signed_at
  ) THEN
    RAISE EXCEPTION 'MANIFEST_SIGNATURE_IMMUTABLE'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER final_manifest_signature_immutable
  BEFORE UPDATE ON final_manifests
  FOR EACH ROW
  EXECUTE PROCEDURE reject_manifest_signature_mutation();
