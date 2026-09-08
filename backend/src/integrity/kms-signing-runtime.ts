import { createPublicKey } from "node:crypto";
import { KMSClient, GetPublicKeyCommand, SignCommand, type GetPublicKeyCommandInput, type GetPublicKeyCommandOutput, type SignCommandInput, type SignCommandOutput } from "@aws-sdk/client-kms";
import type { Clock } from "../clock.js";
import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import { DomainError } from "../domain/errors.js";
import { MANIFEST_SIGNATURE_ALGORITHMS, verifyManifestIntegrity, type ManifestSignatureAlgorithm } from "../domain/manifest-signing.js";
import { loadManifestSigningRuntime, parseTrustList, validateAlgorithmKey, type ManifestSigningRuntime, type ManifestTrustList } from "./signing-runtime.js";
import { assertRegistrySigningKey, installSignedTrustRegistryReader, loadSignedTrustRegistryRuntime } from "./trust-registry-runtime.js";

export interface KmsSigningTransport {
  getPublicKey(input: GetPublicKeyCommandInput): Promise<GetPublicKeyCommandOutput>;
  sign(input: SignCommandInput): Promise<SignCommandOutput>;
}
function awsTransport(region: string): KmsSigningTransport {
  // Use the default ECS/SDK credential chain. Neither credentials nor client configuration are logged.
  const client = new KMSClient({ region, maxAttempts: 3 });
  return {
    getPublicKey: input => client.send(new GetPublicKeyCommand(input), { abortSignal: AbortSignal.timeout(10000) }),
    sign: input => client.send(new SignCommand(input), { abortSignal: AbortSignal.timeout(10000) }),
  };
}
const invalid = (message: string): never => { throw new Error(`Invalid manifest KMS configuration: ${message}`); };
/** Asynchronous startup seam; local PEM and unsigned modes retain their existing synchronous loader. */
export async function initializeManifestSigningRuntime(clock: Clock, env: NodeJS.ProcessEnv = process.env, transport?: KmsSigningTransport): Promise<ManifestSigningRuntime> {
  if ((env.PACKPROOF_MANIFEST_SIGNING_MODE?.trim() || "unsigned") !== "kms") return loadManifestSigningRuntime(clock, env);
  const requiredRaw = env.PACKPROOF_MANIFEST_SIGNING_REQUIRED ?? "false";
  if (!["true", "false"].includes(requiredRaw)) invalid("required flag must be true or false");
  const keyArn = env.PACKPROOF_MANIFEST_KMS_KEY_ARN?.trim() || "";
  const arn = /^arn:(aws|aws-us-gov|aws-cn):kms:([a-z0-9-]+):\d{12}:key\/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$/.exec(keyArn);
  if (!arn) invalid("an exact asymmetric KMS key ARN is required; aliases are not accepted");
  const keyId = env.PACKPROOF_MANIFEST_SIGNING_KEY_ID?.trim() || keyArn;
  if (!/^[A-Za-z0-9_:/.-]{1,200}$/.test(keyId)) invalid("a stable public key ID is required");
  const algorithm = env.PACKPROOF_MANIFEST_SIGNING_ALGORITHM as ManifestSignatureAlgorithm;
  if (!(MANIFEST_SIGNATURE_ALGORITHMS as readonly string[]).includes(algorithm)) invalid("choose ECDSA_SHA_256 or RSASSA_PSS_SHA_256");
  if (env.PACKPROOF_MANIFEST_SIGNING_KEY_FILE || env.PACKPROOF_MANIFEST_TRUST_LIST_FILE) invalid("KMS mode does not use private PEM or mounted trust-list files");
  const ttlSeconds = Number(env.PACKPROOF_MANIFEST_TRUST_TTL_SECONDS ?? 604800);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 300 || ttlSeconds > 2592000) invalid("trust TTL must be 300 through 2592000 seconds");
  const client = transport ?? awsTransport(arn![2]);
  let previousPublicPem: string | null = null;
  let refreshPromise: Promise<void> | null = null;
  const registryConfigured = !!(env.PACKPROOF_MANIFEST_SIGNED_TRUST_REGISTRY_FILE || env.PACKPROOF_MANIFEST_REGISTRY_AUTHORITY_KEYS_FILE);
  const runtime: ManifestSigningRuntime = {
    trustList: null,
    publicStatus: { mode: "SIGNED", keyId, algorithm, required: requiredRaw === "true", trustListSha256: null, provider: "AWS_KMS" },
  };
  async function refreshTrust(): Promise<void> {
    let output: GetPublicKeyCommandOutput;
    try { output = await client.getPublicKey({ KeyId: keyArn }); }
    catch { return invalid("public signing key is unavailable or task-role access was denied"); }
    const compatibleSpec = algorithm === "ECDSA_SHA_256" ? output.KeySpec === "ECC_NIST_P256" : ["RSA_2048", "RSA_3072", "RSA_4096"].includes(output.KeySpec ?? "");
    if (output.KeyId !== keyArn || output.KeyUsage !== "SIGN_VERIFY" || !compatibleSpec || !output.SigningAlgorithms?.includes(algorithm) || !output.PublicKey?.length)
      invalid("KMS key usage, key spec, ARN or supported signing algorithm does not match");
    let publicKeyPem: string;
    try {
      const key = createPublicKey({ key: Buffer.from(output.PublicKey!), format: "der", type: "spki" });
      validateAlgorithmKey(key, algorithm);
      publicKeyPem = key.export({ format: "pem", type: "spki" }).toString();
    } catch { return invalid("KMS returned an invalid or incompatible public key"); }
    if (previousPublicPem && previousPublicPem !== publicKeyPem) invalid("the exact signing key unexpectedly changed");
    const registry = loadSignedTrustRegistryRuntime(clock, env);
    if (registry) {
      assertRegistrySigningKey(registry, clock, { keyId, algorithm, publicKeyPem });
      previousPublicPem = publicKeyPem;
      Object.assign(runtime, registry);
      runtime.publicStatus.trustSource = "SIGNED_REGISTRY";
      runtime.publicStatus.trustRegistrySha256 = sha256Hex(registry.signedTrustRegistryJson);
      runtime.publicStatus.trustListSha256 = sha256Hex(canonicalize(registry.trustList));
      return;
    }
    const generatedAt = clock.now().toISOString();
    const expiresAt = new Date(clock.now().getTime() + ttlSeconds * 1000).toISOString();
    let historical: unknown = [];
    if (env.PACKPROOF_MANIFEST_TRUST_HISTORY_JSON) {
      if (Buffer.byteLength(env.PACKPROOF_MANIFEST_TRUST_HISTORY_JSON) > 256 * 1024) invalid("historical public trust data exceeds limit");
      try { historical = JSON.parse(env.PACKPROOF_MANIFEST_TRUST_HISTORY_JSON); } catch { return invalid("historical public trust data must be a JSON array"); }
    }
    const historicalKeys = Array.isArray(historical) ? historical : invalid("historical public trust data must be an array");
    if (historicalKeys.some(key => key?.keyId === keyId)) invalid("historical trust keys must be distinct from the current signing key");
    const list: ManifestTrustList = parseTrustList(Buffer.from(JSON.stringify({ schema: "packproof.trust-list.v1", generatedAt, expiresAt,
      keys: [...historicalKeys, { keyId, algorithm, publicKeyPem, status: "ACTIVE" }] })));
    previousPublicPem = publicKeyPem;
    runtime.trustList = list;
    runtime.publicStatus.trustSource = "LEGACY_TRUST_LIST";
    runtime.publicStatus.trustListSha256 = sha256Hex(canonicalize(list));
  }
  await refreshTrust(); // Fail startup before any finalization can be accepted.
  installSignedTrustRegistryReader(runtime, clock, env);
  runtime.signer = {
    async signManifest(input) {
      if (sha256Hex(input.canonicalJson) !== input.sha256) throw new DomainError("MANIFEST_SIGNING_FAILED", "The frozen manifest could not be signed", 503);
      if (registryConfigured) {
        // A signer can consume a separately reviewed rotation/revocation file,
        // but cannot extend the registry review date by generating its own list.
        try {
          const registry = loadSignedTrustRegistryRuntime(clock, env)!;
          Object.assign(runtime, registry);
          runtime.publicStatus.trustRegistrySha256 = sha256Hex(registry.signedTrustRegistryJson);
          runtime.publicStatus.trustListSha256 = sha256Hex(canonicalize(registry.trustList));
          assertRegistrySigningKey(registry, clock, { keyId, algorithm, publicKeyPem: previousPublicPem! });
        } catch { throw new DomainError("MANIFEST_TRUST_REFRESH_FAILED", "The signed trust registry needs an operational review", 503); }
      }
      const refreshBeforeMs = Math.min(ttlSeconds * 1000 / 4, 3600000);
      if (!registryConfigured && Date.parse(runtime.trustList!.expiresAt) - clock.now().getTime() <= refreshBeforeMs) {
        if (!refreshPromise) refreshPromise = refreshTrust().finally(() => { refreshPromise = null; });
        try { await refreshPromise; }
        catch { throw new DomainError("MANIFEST_TRUST_REFRESH_FAILED", "Signing trust information could not be refreshed", 503); }
      }
      let result: SignCommandOutput;
      try {
        result = await client.sign({ KeyId: keyArn, SigningAlgorithm: algorithm,
          Message: Buffer.from(input.sha256, "hex"), MessageType: "DIGEST" });
      } catch { throw new DomainError("MANIFEST_SIGNING_FAILED", "The signing service could not sign the frozen manifest", 503); }
      if (result.KeyId !== keyArn || result.SigningAlgorithm !== algorithm || !result.Signature?.length)
        throw new DomainError("MANIFEST_SIGNING_FAILED", "The signing service returned an incompatible signature", 503);
      const signature = { algorithm, keyId, signatureBase64: Buffer.from(result.Signature).toString("base64"), signedAt: clock.now().toISOString() };
      // A transport success is insufficient: validate the returned bytes against the independently fetched public key.
      if (!verifyManifestIntegrity({ canonicalJson: input.canonicalJson, expectedSha256: input.sha256, signature, publicKeyPem: previousPublicPem }).signatureValid)
        throw new DomainError("MANIFEST_SIGNING_FAILED", "The returned manifest signature did not verify", 503);
      return signature;
    },
  };
  return runtime;
}
