# Manifest signing and offline trust distribution

The API can now sign new frozen manifests during the original finalization transaction. Both the human endpoint and `/v1` platform endpoint use the same configured signer. Signing never changes canonical JSON, SHA-256 meaning, evidence requirements, or the append-only model. Retried finalization returns the stored signature without signing again. Existing unsigned manifests remain unsigned; signature metadata cannot be backfilled into their immutable rows.

Two adapters are available: AWS KMS remote asymmetric signing, and an operator-provisioned PEM file mounted into the API container. The KMS adapter keeps private key operations in AWS KMS and requires no private file mount. The PEM adapter accepts an operator-provisioned PEM file mounted into the API container. It supports P-256 ECDSA/SHA-256 with DER signatures and RSA-PSS/SHA-256 with 32-byte salt and at least 2048-bit RSA keys. PEM mode is software signing: the private key exists in API process memory. It does not provide KMS/HSM isolation or an independent timestamp. Both adapters implement the same `ManifestSigner` interface.

No production key or production trust identity is generated, committed, or provisioned by this implementation. The deployment scripts currently do not mount PEM files. KMS mode instead uses an exact key ARN and narrow task-role permissions. Runtime source readiness is not evidence that the running production service is signing.

## Required operator configuration

| Setting | Meaning |
| --- | --- |
| `PACKPROOF_MANIFEST_SIGNING_MODE` | `unsigned` (default), `pem`, or `kms`. Unknown values fail startup. |
| `PACKPROOF_MANIFEST_SIGNING_REQUIRED` | `true` requires a configured signer; `false` permits explicitly unsigned operation. Use `true` for a release advertised as signing new Proofs. |
| `PACKPROOF_MANIFEST_SIGNING_KEY_FILE` | Absolute path to the existing mounted private PEM file; never the PEM contents. |
| `PACKPROOF_MANIFEST_SIGNING_KEY_ID` | Stable public signing-key identifier matching the trust list; never reuse an ID for different key material. |
| `PACKPROOF_MANIFEST_SIGNING_ALGORITHM` | `ECDSA_SHA_256` or `RSASSA_PSS_SHA_256`; must match the key type and trust entry. |
| `PACKPROOF_MANIFEST_TRUST_LIST_FILE` | Path to separately prepared public JSON trust material. Required in PEM mode. May also be set in unsigned mode to publish historical verification keys. |

Configuration is validated before opening the database or starting workers. Missing files, unreadable files, wrong key types, mismatched public/private key pairs, revoked active keys, expired/future trust lists, invalid required-mode combinations, and stray key configuration in unsigned mode fail startup. PEM mode never falls back to unsigned operation. A trust list that expires while the process is running blocks new signed finalizations with `MANIFEST_TRUST_EXPIRED`; capture and access to existing records continue. Any signing error rolls back the whole finalization transaction.

Mount the private key read-only, owned by the API process user, with POSIX mode `0400` or `0600`; group/other-readable private files are rejected. The shipped Dockerfile runs as `node`, so container UID/file ownership must match. Put the key outside the build context and source checkout. The public trust JSON can be readable by the API user without secret permissions. Do not use a production private key in a test fixture, build argument, image layer, repository secret dump, support attachment, browser bundle, or local demonstration. The tests generate short-lived test-only keys in temporary folders and delete them afterward.

## Public verification material

`GET /.well-known/packproof-trust.json` publishes only the normalized public trust schema. If none is configured, it returns `503 MANIFEST_TRUST_NOT_CONFIGURED`. Unknown JSON properties are stripped before publication; file paths and private key material are never returned. The endpoint is publicly readable so a reviewer does not need a PackProof login.

`GET /integrity/signing` reports configured signed/unsigned mode, public key ID, algorithm, required-mode setting, and SHA-256 of the **canonicalized public trust-list content**. That digest is a diagnostic identifier, not a signature or an independently established trust anchor. The ordinary HTTP response may have different whitespace, so its raw file digest need not equal that canonical content identifier.

A trust file uses `packproof.trust-list.v1`, timezone-qualified `generatedAt` and `expiresAt`, and public keys with `keyId`, `algorithm`, `publicKeyPem`, and `status` (`ACTIVE` or `REVOKED`). A key's status applies to verification; retaining an old key as active permits historical signatures to verify even after its private key is retired from issuance. Mark compromised keys revoked and retain the entry so the verifier reports the reason distinctly.

## Independent distribution and rotation

1. Have the operator obtain the production public key from its existing controlled signing-key provisioning process. Prepare the public trust list and verify its fingerprint through an independently authenticated channel. Do not derive trust from a key found inside an exported ZIP.
2. Publish the trust list separately from evidence exports over the official HTTPS endpoint and the chosen authenticated release/distribution channel. Publish its raw download checksum and public-key fingerprints through that authenticated channel. A checksum hosted with a malicious replacement file does not independently authenticate the file.
3. Distribute `verifier/verify.py`, `verifier/README.md` and `verifier/canonical-vectors.json` as a separately obtained verifier release. Publish the release checksum through the same established software-distribution process. Do not ship an executable verifier inside a customer evidence archive and ask reviewers to run it.
4. On rotation, add the new public key before enabling new issuance. Keep historical public keys. Securely replace the mounted key/trust files and restart all API instances so their configured identity and public list agree. Do not mutate previously finalized manifests.
5. On revocation, publish the updated list promptly, stop using the compromised private key, replace the runtime configuration, and tell offline reviewers how to obtain the update. An offline reviewer with an older list cannot discover this event automatically. The verifier always reports list freshness and never treats `signedAt` as an independently trusted filming timestamp.

Example reviewer workflow, after independently authenticating the verifier and downloaded trust file:

```bash
python3 verify.py proof.zip --trust-list independently-obtained-trust.json
```

Use `--expected-manifest-sha256` with a separately authenticated digest for existing unsigned records. A public-key signature only authenticates the frozen manifest. Later shipment/access supplements and export inventories retain their explicit self-consistency boundary. A scoped recipient export is always `DISCLOSURE_ONLY`; excluded originals do not become verified merely because selected bytes are consistent.

## Release evidence and remaining gates

`backend/tests/manifest-signing-runtime.test.ts` exercises actual HTTP finalization, immutable signature persistence, retries without resigning, Python/OpenSSL verification of the real exported ZIP, public trust projection, RSA-PSS interoperability, failed-signer transaction rollback, and missing/expired/revoked/mismatched/unsafe configuration. Existing package, lifecycle, and unsigned workflows remain covered.

Before claiming production signing, verify the deployed revision, inspect `/integrity/signing`, independently authenticate the published public key, finalize a consented staging fixture through the deployed API, export it, and verify it using a separately distributed verifier and trust file. Repeat with modified bytes, missing media and revoked/unknown keys. Refresh expiry before it blocks new finalization. Do not describe the signing time as camera capture time or a signature as a verdict about physical truth.

## AWS KMS deployment without private file mounts

KMS mode uses `@aws-sdk/client-kms` through the standard ECS task-role credential chain. Startup calls `GetPublicKey`, validates the exact returned key ARN, `SIGN_VERIFY` usage, key specification, and advertised signing algorithm, and publishes that verified public key through the existing trust endpoint. No key, alias, grant, IAM role or credential is created by the runtime. Public key export is an AWS KMS operation; private key material is never requested. [AWS GetPublicKey](https://docs.aws.amazon.com/kms/latest/APIReference/API_GetPublicKey.html)

Provision an asymmetric KMS key with `KeyUsage=SIGN_VERIFY` and `KeySpec=ECC_NIST_P256` for the recommended existing ECDSA format. RSA_2048, RSA_3072 and RSA_4096 are also supported with `RSASSA_PSS_SHA_256`. Use its exact immutable key ARN, never an alias that can be retargeted. Set the container configuration:

```text
PACKPROOF_MANIFEST_SIGNING_MODE=kms
PACKPROOF_MANIFEST_SIGNING_REQUIRED=true
PACKPROOF_MANIFEST_KMS_KEY_ARN=arn:aws:kms:REGION:ACCOUNT:key/EXISTING-KEY-UUID
PACKPROOF_MANIFEST_SIGNING_KEY_ID=packproof-signing-2026-01
PACKPROOF_MANIFEST_SIGNING_ALGORITHM=ECDSA_SHA_256
PACKPROOF_MANIFEST_TRUST_TTL_SECONDS=604800
```

The public `SIGNING_KEY_ID` may be omitted to use the key ARN. The ARN's region selects the SDK client region. `PACKPROOF_MANIFEST_TRUST_TTL_SECONDS` is bounded to 300–2,592,000 seconds and defaults to seven days. In KMS mode, omit private PEM/trust file settings; they are rejected to prevent mixed or silently ignored configuration.

Attach this narrow permission to the **API ECS task role**, substituting the exact existing key ARN. Its KMS key policy must also authorize that role directly or permit the account's IAM policy delegation. Do not attach a wildcard KMS grant or grant key-management actions to the API. `kms:Verify` is unnecessary because returned signatures are checked locally against the downloaded public key.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PackProofManifestSigning",
      "Effect": "Allow",
      "Action": ["kms:Sign", "kms:GetPublicKey"],
      "Resource": "arn:aws:kms:REGION:ACCOUNT:key/EXISTING-KEY-UUID"
    }
  ]
}
```

The key policy's corresponding least-privilege statement uses the exact API task-role ARN as its `Principal`, actions `kms:Sign` and `kms:GetPublicKey`, and `Resource: "*"` **inside that one key's policy**. Preserve the existing key administrators and recovery/deletion controls. Do not replace the whole key policy merely to add this runtime permission. [KMS key-policy principal and resource semantics](https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-overview.html) No runtime permission to `CreateKey`, `PutKeyPolicy`, `ScheduleKeyDeletion`, `CreateAlias`, `Encrypt`, `Decrypt`, or secret retrieval is needed. AWS identifies `kms:Sign` and `kms:GetPublicKey` as the required key-policy permissions. [Sign permissions](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html), [GetPublicKey permissions](https://docs.aws.amazon.com/kms/latest/APIReference/API_GetPublicKey.html)

Each finalization sends only the existing 32-byte SHA-256 digest with `MessageType=DIGEST`; it never uploads the manifest text or media to KMS. This avoids the 4,096-byte raw-message limit and prevents hashing the digest twice. The response must name the same ARN/algorithm and its signature must verify locally before the database stores it. Requests use a ten-second abort budget and at most three SDK attempts. KMS failure rolls back finalization and never switches to unsigned output. A later user retry may request another signature if the earlier transaction did not commit, but a committed manifest is never resigned. [AWS Sign digest semantics](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html)

## KMS public trust freshness and rotation

The runtime constructs the active public trust entry after a successful authenticated `GetPublicKey` call. It does not invent or generate a key. The resulting trust endpoint must still be independently authenticated by reviewers; a public key fetched from an arbitrary service or bundled package is not automatically trusted.

Before signing near trust expiry, the runtime refreshes `GetPublicKey` and the public list dates, sharing one refresh across concurrent finalizations. If that refresh fails, signing fails closed. Without signing traffic a previously published list may expire; the offline verifier correctly reports it stale until a refreshed copy is obtained. The public endpoint does not make per-view AWS calls. Different replicas can publish different refresh timestamps for the same verified key.

For rotation, configure `PACKPROOF_MANIFEST_TRUST_HISTORY_JSON` as a nonsecret JSON array of previous `ManifestTrustKey` entries (public PEM, key ID, algorithm, and `ACTIVE`/`REVOKED` status). The current KMS key is added automatically and may not duplicate a historical key ID. Preserve previous public keys when changing the active ARN. Carry revoked keys forward explicitly. The parser strips unexpected fields, rejects private PEM data, and enforces the same public-key format as the offline verifier. KMS key disablement prevents signing; offline revocation still requires publishing the old key as `REVOKED` in the updated trust list during the replacement-key rollout. Do not confuse disabling cloud usage with recalling previously exported offline trust lists.

The application automatically refreshes only its current KMS public key and timestamp window. Historical revocation decisions remain operator-supplied configuration; update them through the deployment's controlled configuration process. Refreshing an active key does not independently discover a later operator revocation that has not been published/configured.

`backend/tests/kms-signing-runtime.test.ts` uses an injected transport and ephemeral test-only signing keys. It checks digest transport for a manifest larger than the raw KMS limit, actual local signature verification, explicit algorithm/usage/ARN mismatch rejection, service denial, corrupt returned signatures, concurrent trust refresh, historical revocation retention, and refresh failure. No test invokes AWS or provisions a key. Real task-role/KMS configuration still requires the deployed fixture check described above.
