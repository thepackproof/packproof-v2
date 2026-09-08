import { constants, createPrivateKey, createPublicKey, sign, timingSafeEqual, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Clock } from "../clock.js";
import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import { DomainError } from "../domain/errors.js";
import { MANIFEST_SIGNATURE_ALGORITHMS, type ManifestSignatureAlgorithm, type ManifestSigner } from "../domain/manifest-signing.js";
import type { SignedTrustRegistry } from "../domain/signing-trust.js";
import { assertRegistrySigningKey, installSignedTrustRegistryReader, loadSignedTrustRegistryRuntime } from "./trust-registry-runtime.js";

export interface ManifestTrustKey {
  keyId: string;
  algorithm: ManifestSignatureAlgorithm;
  publicKeyPem: string;
  status: "ACTIVE" | "REVOKED";
}
export interface ManifestTrustList {
  schema: "packproof.trust-list.v1";
  generatedAt: string;
  expiresAt: string;
  keys: ManifestTrustKey[];
}
export interface ManifestSigningRuntime {
  signer?: ManifestSigner;
  publicStatus: { mode: "SIGNED" | "UNSIGNED"; algorithm: ManifestSignatureAlgorithm | null; keyId: string | null; required: boolean; trustListSha256: string | null; provider?: "AWS_KMS" | "PEM"; trustSource?: "SIGNED_REGISTRY" | "LEGACY_TRUST_LIST"; trustRegistrySha256?: string };
  trustList: ManifestTrustList | null;
  signedTrustRegistryJson?: string;
  signedTrustRegistry?: SignedTrustRegistry;
  registryAuthorityKeys?: Record<string, string>;
  readSignedTrustRegistry?: () => string;
}
const invalid = (detail: string): never => { throw new Error(`Invalid manifest signing configuration: ${detail}`); };
function readBoundedFile(file: string, maximum: number, privateFile = false): Buffer {
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size === 0 || info.size > maximum) invalid("signing material must be a bounded regular file");
    if (privateFile && process.platform !== "win32" && (info.mode & 0o077) !== 0)
      invalid("private key file must not be readable by group or other users (use mode 0400 or 0600)");
    return readFileSync(file);
  } catch { return invalid("signing material is unavailable, unsafe, or unreadable"); }
}
export function parseTrustList(bytes: Buffer): ManifestTrustList {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return invalid("trust list must be JSON"); }
  const input = value as ManifestTrustList;
  if (input?.schema !== "packproof.trust-list.v1" || !Array.isArray(input.keys) || input.keys.length > 100)
    invalid("unsupported trust list schema or key count");
  const timestamp = (time: unknown) => typeof time === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(time) && Number.isFinite(Date.parse(time));
  if (!timestamp(input.generatedAt) || !timestamp(input.expiresAt) || Date.parse(input.expiresAt) <= Date.parse(input.generatedAt))
    invalid("trust list needs a valid issuance and expiry window");
  const seen = new Set<string>();
  const keys = input.keys.map(key => {
    if (!key || typeof key.keyId !== "string" || !/^[A-Za-z0-9_:/.-]{1,200}$/.test(key.keyId) || seen.has(key.keyId)
        || !(MANIFEST_SIGNATURE_ALGORITHMS as readonly string[]).includes(key.algorithm)
        || !["ACTIVE", "REVOKED"].includes(key.status) || typeof key.publicKeyPem !== "string"
        || key.publicKeyPem.includes("PRIVATE") || key.publicKeyPem.length > 32768)
      invalid("invalid or duplicate public trust key");
    seen.add(key.keyId);
    let parsed: KeyObject;
    try { parsed = createPublicKey(key.publicKeyPem); } catch { return invalid("invalid public verification key"); }
    validateAlgorithmKey(parsed!, key.algorithm);
    // Publish a strict projection. Unknown JSON fields can never leak private configuration.
    return { keyId: key.keyId, algorithm: key.algorithm, status: key.status, publicKeyPem: parsed!.export({ type: "spki", format: "pem" }).toString() };
  });
  return { schema: "packproof.trust-list.v1", generatedAt: input.generatedAt, expiresAt: input.expiresAt, keys };
}
export function validateAlgorithmKey(key: KeyObject, algorithm: ManifestSignatureAlgorithm): void {
  if (algorithm === "ECDSA_SHA_256" && (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1"))
    invalid("ECDSA signing requires a P-256 key");
  if (algorithm === "RSASSA_PSS_SHA_256" && (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048))
    invalid("RSA-PSS signing requires an RSA key of at least 2048 bits");
}
function trustIsCurrent(trust: ManifestTrustList, clock: Clock): boolean {
  const now = clock.now().getTime();
  return Date.parse(trust.generatedAt) <= now && now < Date.parse(trust.expiresAt);
}
/** Configuration only: never creates keys, modifies key files, or falls back after a signing error. */
export function loadManifestSigningRuntime(clock: Clock, env: NodeJS.ProcessEnv = process.env): ManifestSigningRuntime {
  const mode = env.PACKPROOF_MANIFEST_SIGNING_MODE?.trim() || "unsigned";
  const rawRequired = env.PACKPROOF_MANIFEST_SIGNING_REQUIRED ?? "false";
  if (!["true", "false"].includes(rawRequired)) invalid("PACKPROOF_MANIFEST_SIGNING_REQUIRED must be true or false");
  const required = rawRequired === "true";
  if (!["unsigned", "pem"].includes(mode)) invalid("choose unsigned or pem mode");
  const trustPath = env.PACKPROOF_MANIFEST_TRUST_LIST_FILE?.trim();
  const registry = loadSignedTrustRegistryRuntime(clock, env);
  const trustList = registry?.trustList ?? (trustPath ? parseTrustList(readBoundedFile(trustPath, 1024 * 1024)) : null);
  if (mode === "unsigned") {
    if (required) invalid("signed manifests are required but no signer is configured");
    if (env.PACKPROOF_MANIFEST_SIGNING_KEY_FILE || env.PACKPROOF_MANIFEST_SIGNING_KEY_ID || env.PACKPROOF_MANIFEST_SIGNING_ALGORITHM || env.PACKPROOF_MANIFEST_KMS_KEY_ARN)
      invalid("key configuration cannot be silently ignored in unsigned mode");
    const runtime: ManifestSigningRuntime = { ...registry, trustList, publicStatus: { mode: "UNSIGNED", algorithm: null, keyId: null, required, trustListSha256: trustList ? sha256Hex(canonicalize(trustList)) : null, ...(registry ? { trustSource: "SIGNED_REGISTRY", trustRegistrySha256: sha256Hex(registry.signedTrustRegistryJson) } : {}) } };
    installSignedTrustRegistryReader(runtime, clock, env);
    return runtime;
  }
  const keyFile = env.PACKPROOF_MANIFEST_SIGNING_KEY_FILE?.trim();
  const keyId = env.PACKPROOF_MANIFEST_SIGNING_KEY_ID?.trim();
  const algorithm = env.PACKPROOF_MANIFEST_SIGNING_ALGORITHM as ManifestSignatureAlgorithm;
  if (!keyFile || !keyId || !/^[A-Za-z0-9_:/.-]{1,200}$/.test(keyId) || !(MANIFEST_SIGNATURE_ALGORITHMS as readonly string[]).includes(algorithm))
    invalid("PEM mode requires a key file, stable key ID, and supported algorithm");
  if (!trustList || !trustIsCurrent(trustList, clock)) invalid("PEM mode requires a current independently distributed public trust list");
  const material = readBoundedFile(keyFile!, 65536, true);
  let privateKey: KeyObject;
  try { privateKey = createPrivateKey(material); }
  catch { return invalid("private signing key could not be loaded"); }
  finally { material.fill(0); }
  validateAlgorithmKey(privateKey!, algorithm);
  const active = trustList!.keys.find(key => key.keyId === keyId && key.algorithm === algorithm && key.status === "ACTIVE");
  if (!active) invalid("active signing key is absent or revoked in the trust list");
  const actualPublic = createPublicKey(privateKey!).export({ type: "spki", format: "der" });
  const publicKeyPem = createPublicKey(privateKey!).export({ type: "spki", format: "pem" }).toString();
  if (registry) assertRegistrySigningKey(registry, clock, { keyId: keyId!, algorithm, publicKeyPem });
  const expectedPublic = createPublicKey(active!.publicKeyPem).export({ type: "spki", format: "der" });
  if (actualPublic.length !== expectedPublic.length || !timingSafeEqual(actualPublic, expectedPublic)) invalid("signing and published verification keys differ");
  const signer: ManifestSigner = {
    async signManifest(input) {
      if (registry) {
        try {
          const refreshed = loadSignedTrustRegistryRuntime(clock, env)!;
          Object.assign(runtime, refreshed);
          runtime.publicStatus.trustRegistrySha256 = sha256Hex(refreshed.signedTrustRegistryJson);
          runtime.publicStatus.trustListSha256 = sha256Hex(canonicalize(refreshed.trustList));
          assertRegistrySigningKey(refreshed, clock, { keyId: keyId!, algorithm, publicKeyPem });
        } catch { throw new DomainError("MANIFEST_TRUST_EXPIRED", "The signed trust registry needs an operational review", 503); }
      } else if (!trustIsCurrent(trustList!, clock)) throw new DomainError("MANIFEST_TRUST_EXPIRED", "Signing trust information needs an operational refresh", 503);
      if (sha256Hex(input.canonicalJson) !== input.sha256) throw new DomainError("MANIFEST_SIGNING_FAILED", "The frozen manifest could not be signed", 503);
      let signed: Buffer;
      try {
        signed = sign("sha256", Buffer.from(input.canonicalJson), algorithm === "RSASSA_PSS_SHA_256"
          ? { key: privateKey!, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }
          : { key: privateKey!, dsaEncoding: "der" });
      } catch { throw new DomainError("MANIFEST_SIGNING_FAILED", "The frozen manifest could not be signed", 503); }
      return { algorithm, keyId: keyId!, signatureBase64: signed.toString("base64"), signedAt: clock.now().toISOString() };
    },
  };
  const runtime: ManifestSigningRuntime = { ...registry, signer, trustList, publicStatus: { mode: "SIGNED", keyId: keyId!, algorithm, required, trustListSha256: sha256Hex(canonicalize(trustList)), trustSource: registry ? "SIGNED_REGISTRY" : "LEGACY_TRUST_LIST", ...(registry ? { trustRegistrySha256: sha256Hex(registry.signedTrustRegistryJson) } : {}) } };
  installSignedTrustRegistryReader(runtime, clock, env);
  return runtime;
}
