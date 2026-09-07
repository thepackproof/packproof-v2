import { createPublicKey, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Clock } from "../clock.js";
import { parseSignedTrustRegistry, verifySignedTrustRegistry, type SignedTrustRegistry } from "../domain/signing-trust.js";
import type { ManifestSignatureAlgorithm } from "../domain/manifest-signing.js";
import type { ManifestTrustList } from "./signing-runtime.js";
import type { ManifestSigningRuntime } from "./signing-runtime.js";
import { DomainError } from "../domain/errors.js";
import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";

const invalid = (detail: string): never => { throw new Error(`Invalid signed trust registry configuration: ${detail}`); };
function readPublicFile(file: string): string {
  try {
    const info = statSync(file);
    if (!info.isFile() || !info.size || info.size > 1024 * 1024) return invalid("files must be bounded regular files");
    const text = readFileSync(file, "utf8");
    if (text.includes("PRIVATE KEY")) return invalid("only public material is allowed");
    return text;
  } catch { return invalid("public registry or pinned authority file is unavailable"); }
}
export interface LoadedTrustRegistry {
  signedTrustRegistryJson: string;
  signedTrustRegistry: SignedTrustRegistry;
  registryAuthorityKeys: Record<string, string>;
  trustList: ManifestTrustList;
}
/** Authority pins are an operator-supplied independent file, never keys from the registry or archive. */
export function loadSignedTrustRegistryRuntime(clock: Clock, env: NodeJS.ProcessEnv): LoadedTrustRegistry | null {
  const registryPath = env.PACKPROOF_MANIFEST_SIGNED_TRUST_REGISTRY_FILE?.trim();
  const authorityPath = env.PACKPROOF_MANIFEST_REGISTRY_AUTHORITY_KEYS_FILE?.trim();
  if (!registryPath && !authorityPath) return null;
  if (!registryPath || !authorityPath) return invalid("both signed registry and independent authority-key files are required");
  if (env.PACKPROOF_MANIFEST_TRUST_LIST_FILE || env.PACKPROOF_MANIFEST_TRUST_HISTORY_JSON) return invalid("choose signed registry or legacy trust configuration");
  const signedTrustRegistryJson = readPublicFile(registryPath);
  let signedTrustRegistry: SignedTrustRegistry, registryAuthorityKeys: Record<string, string>;
  try {
    signedTrustRegistry = parseSignedTrustRegistry(Buffer.from(signedTrustRegistryJson));
    const pins: unknown = JSON.parse(readPublicFile(authorityPath));
    if (!pins || typeof pins !== "object" || Array.isArray(pins) || Object.keys(pins).length === 0 || Object.keys(pins).length > 100) return invalid("authority pins must map stable key IDs to public PEM keys");
    registryAuthorityKeys = Object.create(null) as Record<string, string>;
    for (const [keyId, pem] of Object.entries(pins)) {
      if (!/^[A-Za-z0-9_:/.-]{1,200}$/.test(keyId) || typeof pem !== "string" || !pem.includes("-----BEGIN PUBLIC KEY-----") || pem.includes("PRIVATE") || pem.length > 32768) return invalid("invalid independently pinned authority");
      createPublicKey(pem);
      registryAuthorityKeys[keyId] = pem;
    }
  } catch { return invalid("invalid signed registry or independently pinned authority"); }
  const validity = verifySignedTrustRegistry(signedTrustRegistry, registryAuthorityKeys, clock.now());
  if (!validity.signatureValid) return invalid("registry signature, authority, or publication date is not trusted");
  if (!validity.current) return invalid("registry needs a current independently approved review");
  const { registry } = signedTrustRegistry;
  // The legacy schema cannot express dated retirement. Its compatibility view
  // conservatively marks historical/non-current keys revoked; use the signed
  // registry endpoint and verifier for historical validity windows.
  const now = clock.now().getTime();
  const trustList: ManifestTrustList = { schema: "packproof.trust-list.v1", generatedAt: registry.publishedAt, expiresAt: registry.nextReviewAt,
    keys: registry.keys.map(key => ({ keyId: key.keyId, algorithm: key.algorithm, publicKeyPem: key.publicKeyPem,
      status: key.status === "ACTIVE" && Date.parse(key.validFrom) <= now && (!key.validUntil || now <= Date.parse(key.validUntil)) ? "ACTIVE" : "REVOKED" })) };
  return { signedTrustRegistryJson, signedTrustRegistry, registryAuthorityKeys, trustList };
}
export function assertRegistrySigningKey(loaded: LoadedTrustRegistry, clock: Clock, input: {keyId: string; algorithm: ManifestSignatureAlgorithm; publicKeyPem: string}) {
  const key = loaded.signedTrustRegistry.registry.keys.find(row => row.keyId === input.keyId);
  const now = clock.now().getTime();
  if (!key || key.algorithm !== input.algorithm || key.status !== "ACTIVE" || now < Date.parse(key.validFrom) || (key.validUntil && now > Date.parse(key.validUntil))) return invalid("signing key is absent, inactive, revoked, compromised, or outside its validity period");
  const actual = createPublicKey(input.publicKeyPem).export({ type: "spki", format: "der" });
  const expected = createPublicKey(key.publicKeyPem).export({ type: "spki", format: "der" });
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return invalid("signing and registered public keys differ");
}

/** Public distribution reloads the reviewed file independently of signing traffic. */
export function installSignedTrustRegistryReader(runtime: ManifestSigningRuntime, clock: Clock, env: NodeJS.ProcessEnv) {
  if (!runtime.signedTrustRegistry) return;
  runtime.readSignedTrustRegistry = () => {
    try {
      const loaded = loadSignedTrustRegistryRuntime(clock, env)!;
      Object.assign(runtime, loaded);
      runtime.publicStatus.trustSource = "SIGNED_REGISTRY";
      runtime.publicStatus.trustRegistrySha256 = sha256Hex(loaded.signedTrustRegistryJson);
      runtime.publicStatus.trustListSha256 = sha256Hex(canonicalize(loaded.trustList));
      return loaded.signedTrustRegistryJson;
    } catch { throw new DomainError("TRUST_REGISTRY_UNAVAILABLE", "A current independently approved trust registry is unavailable", 503); }
  };
}
