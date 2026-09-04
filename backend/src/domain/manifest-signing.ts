import { constants, createVerify, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "../hash.js";
import { DomainError } from "./errors.js";

export const MANIFEST_SIGNATURE_ALGORITHMS = [
  "ECDSA_SHA_256",
  "RSASSA_PSS_SHA_256",
] as const;

export type ManifestSignatureAlgorithm = (typeof MANIFEST_SIGNATURE_ALGORITHMS)[number];

export interface ManifestSignature {
  algorithm: ManifestSignatureAlgorithm;
  keyId: string;
  signatureBase64: string;
  signedAt: string;
}

export interface ManifestSigner {
  /**
   * Sign the canonical manifest. Production implementations should keep the
   * private key outside the application process (target: AWS KMS asymmetric key).
   */
  signManifest(input: {
    proofId: string;
    manifestId: string;
    canonicalJson: string;
    sha256: string;
  }): Promise<ManifestSignature>;
}

export interface ManifestVerificationResult {
  digestValid: boolean;
  signaturePresent: boolean;
  signatureValid: boolean | null;
  algorithm: ManifestSignatureAlgorithm | null;
  keyId: string | null;
}

export function verifyManifestIntegrity(input: {
  canonicalJson: string;
  expectedSha256: string;
  signature?: ManifestSignature | null;
  publicKeyPem?: string | null;
}): ManifestVerificationResult {
  const actualSha256 = sha256Hex(input.canonicalJson);
  const digestValid = secureDigestEqual(actualSha256, input.expectedSha256);
  const signature = input.signature ?? null;
  if (!signature) {
    return {
      digestValid,
      signaturePresent: false,
      signatureValid: null,
      algorithm: null,
      keyId: null,
    };
  }
  if (!input.publicKeyPem) {
    return {
      digestValid,
      signaturePresent: true,
      signatureValid: null,
      algorithm: signature.algorithm,
      keyId: signature.keyId,
    };
  }
  if (!digestValid) {
    return {
      digestValid: false,
      signaturePresent: true,
      signatureValid: false,
      algorithm: signature.algorithm,
      keyId: signature.keyId,
    };
  }

  let signatureValid: boolean;
  try {
    const verifier = createVerify("sha256");
    verifier.update(input.canonicalJson, "utf8");
    verifier.end();
    const signatureBytes = Buffer.from(signature.signatureBase64, "base64");
    signatureValid =
      signature.algorithm === "RSASSA_PSS_SHA_256"
        ? verifier.verify(
            {
              key: input.publicKeyPem,
              padding: constants.RSA_PKCS1_PSS_PADDING,
              saltLength: 32,
            },
            signatureBytes,
          )
        : verifier.verify(input.publicKeyPem, signatureBytes);
  } catch {
    signatureValid = false;
  }

  return {
    digestValid,
    signaturePresent: true,
    signatureValid,
    algorithm: signature.algorithm,
    keyId: signature.keyId,
  };
}

export function requireManifestSignatureAlgorithm(value: unknown): ManifestSignatureAlgorithm {
  if (
    typeof value === "string" &&
    (MANIFEST_SIGNATURE_ALGORITHMS as readonly string[]).includes(value)
  ) {
    return value as ManifestSignatureAlgorithm;
  }
  throw new DomainError(
    "UNSUPPORTED_MANIFEST_SIGNATURE_ALGORITHM",
    "Unsupported manifest signature algorithm",
    422,
  );
}

function secureDigestEqual(left: string, right: string): boolean {
  const normalizedLeft = left.trim().toLowerCase();
  const normalizedRight = right.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedLeft) || !/^[a-f0-9]{64}$/.test(normalizedRight)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(normalizedLeft, "hex"),
    Buffer.from(normalizedRight, "hex"),
  );
}
