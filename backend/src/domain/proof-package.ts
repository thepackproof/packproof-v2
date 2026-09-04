import { canonicalJson } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import {
  verifyManifestIntegrity,
  type ManifestSignature,
  type ManifestVerificationResult,
} from "./manifest-signing.js";

export const PROOF_PACKAGE_SCHEMA = "packproof.proof-package.v1" as const;

export interface PortableProofPackageV1 {
  schema: typeof PROOF_PACKAGE_SCHEMA;
  proofId: string;
  manifestId: string;
  canonicalManifest: unknown;
  canonicalJson: string;
  manifestSha256: string;
  signature: ManifestSignature | null;
}

export function createProofPackage(input: {
  proofId: string;
  manifestId: string;
  manifest: unknown;
  expectedSha256?: string;
  signature?: ManifestSignature | null;
}): PortableProofPackageV1 {
  const serialized = canonicalJson(input.manifest);
  const digest = sha256Hex(serialized);
  if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== digest) {
    throw new Error("Manifest does not match the expected SHA-256");
  }
  return {
    schema: PROOF_PACKAGE_SCHEMA,
    proofId: input.proofId,
    manifestId: input.manifestId,
    canonicalManifest: input.manifest,
    canonicalJson: serialized,
    manifestSha256: digest,
    signature: input.signature ?? null,
  };
}

export function verifyProofPackage(input: {
  package: PortableProofPackageV1;
  publicKeyPem?: string | null;
}): ManifestVerificationResult & {
  schemaValid: boolean;
  canonicalJsonValid: boolean;
} {
  const pkg = input.package;
  const regeneratedCanonicalJson = canonicalJson(pkg.canonicalManifest);
  const canonicalJsonValid = regeneratedCanonicalJson === pkg.canonicalJson;
  const integrity = verifyManifestIntegrity({
    canonicalJson: pkg.canonicalJson,
    expectedSha256: pkg.manifestSha256,
    signature: pkg.signature,
    publicKeyPem: input.publicKeyPem,
  });
  return {
    schemaValid: pkg.schema === PROOF_PACKAGE_SCHEMA,
    canonicalJsonValid,
    ...integrity,
    digestValid: canonicalJsonValid && integrity.digestValid,
    signatureValid:
      canonicalJsonValid && integrity.signatureValid !== false
        ? integrity.signatureValid
        : false,
  };
}
