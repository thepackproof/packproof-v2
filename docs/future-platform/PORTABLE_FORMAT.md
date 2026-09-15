# Frozen lifecycle portability — WP-08

This implementation extends the existing `packproof.proof-package.v1` ZIP and the independent `verifier/verify.py` program. It does not introduce a second archive format or verifier application. Existing archives continue to work. The independent program uses Python 3.10+ and OpenSSL, opens no network connections, never extracts archive entries, and obtains trust material only from explicit external inputs.

## Signed frozen inventory

An authorized lifecycle export adds `lifecycle/snapshot.json` with `{canonicalJson, sha256, signature}`. Optional outer `snapshotId` and `proofId` mirrors must agree with the signed payload. Both `package.json.sources.lifecycleSnapshot` and `archive.json.sources.lifecycleSnapshot` contain exactly:

```json
{"path":"lifecycle/snapshot.json","sha256":"<SHA-256 of exact canonicalJson UTF-8 bytes>","snapshotId":"<stored snapshot ID>"}
```

The snapshot file is included in the existing archive hash inventory. Its signature, rather than that untrusted inventory alone, authenticates the frozen lifecycle references. The signed payload is version `1`, domain `PACKPROOF_LIFECYCLE_SNAPSHOT`, scope `SEALED_COMMERCE_LIFECYCLE`, and contains:

| Field | Bound meaning |
| --- | --- |
| `snapshotId`, `proofId`, `transactionId` | Stored snapshot, canonical Proof and transaction identities. |
| `tenantId` | Actual persisted API-tenant binding, or explicit `null` for an unbound human workflow. A null value never establishes tenant identity. |
| `actorUserId`, `purpose` | Authenticated requesting actor and `REVIEW`, `CLAIM` or `ARCHIVE` purpose. |
| `createdAt`, `cutoffAt` | Server-recorded creation and inventory cutoff; neither is independently timestamped filming time. |
| `root` | Original manifest ID and SHA-256. The root manifest is not rewritten or resigned. |
| `supplements` | Exact ordered IDs, sequence, SHA-256 and preceding digest of the received signed chain. |
| `stages` | Exact ordered stage ID, type, digest and finalization time for sealed commerce stages. |
| `watermark` | Received supplement sequence and digest. An empty chain references the original root digest. |
| `limitations` | Explicit received-snapshot completeness, unknown offline freshness, unavailable current revocation knowledge, and excluded unsealed records/evidence bytes. |

The closed profile allows at most 256 supplement references and three commerce-stage references. Unknown formats, fields, purposes, or assurance-profile values fail closed. Sealed stage digests are authenticated by the snapshot signature; this does not fabricate historical per-stage signatures.

Stored root, supplement and stage canonical strings are passed through verbatim. Digests and signatures cover their exact UTF-8 bytes. The existing `packproof.sorted-json.v1` serializer is retained and is **not RFC 8785**. New snapshot objects use that existing deterministic profile; independent verification never reconstructs legacy JSON bytes from parsed numbers or strings. ECDSA uses SHA-256, P-256 and DER signatures; RSA-PSS uses SHA-256 and a 32-byte salt, with a minimum 2048-bit RSA key. There are no new cryptographic dependencies.

## Independent verification

Obtain the verifier, registry-authority public key and its identity through an authenticated channel independent of the ZIP. Existing independently supplied legacy trust lists remain supported; the signed registry additionally carries validity, retirement, revocation and compromise status.

```bash
python3 verifier/verify.py proof.zip \
  --trust-registry signed-registry.json \
  --trust-authority-key independently-pinned-authority.pem \
  --trust-authority-key-id trusted-authority-id \
  --expected-proof-id expected-proof-id \
  --expected-lifecycle-snapshot-sha256 expected-snapshot-digest
```

Supply `--expected-tenant-id expected-tenant` when the recipient requires tenant binding. A different recorded tenant returns `TENANT_CONTEXT_MISMATCH`; a null tenant returns `TENANT_BINDING_NOT_ESTABLISHED`. The expected snapshot digest must itself come from an authenticated independent source. It rejects a different historical snapshot and prevents removal of the optional snapshot from masquerading as a sufficient legacy package.

Without an independently known expected snapshot digest, a valid older snapshot can still authenticate its received contents. It **cannot** establish that no later record exists. Results therefore retain `freshness: UNKNOWN_OFFLINE`, `completeness: RECEIVED_SNAPSHOT_ONLY`, and `currentRevocationKnowledge: UNAVAILABLE_OFFLINE`. A fresh local registry does not make revocations published after it discoverable. Offline revocation of already downloaded bytes is not possible.

The verifier keeps root signature, lifecycle signature, supplement signatures, key status, trust freshness, declared context, available-file digest checks, and omissions separate. A mathematically valid signature under a revoked or compromised key is not accepted. Missing or changed files are failures; explicitly unavailable originals produce `OMITTED_FILES` and `completeMedia:false` even when signatures verify. Signature validity does not independently verify a provider observation, actor attestation, physical scene, policy compliance or liability. Those dimensions are reported as unchecked or not evaluated.

The original-media profile declares `derivatives:[]`. Nonempty derivative inventories fail with `UNSUPPORTED_DERIVATION_PROFILE`; changing a claimed parent reference cannot produce successful lineage verification. Signed transformation records and recipient-specific exhibits require the later claim-compiler profile. Arbitrary supplemental archive files remain inventory self-consistency only.

The backend `verifyPortableLifecycleSnapshot` checks the stored signed inventory and referenced manifests using separately configured trust. Its result deliberately reports `availableFileDigests` and `evidenceAvailability` as `NOT_CHECKED`; it does not fetch media. The offline ZIP verifier additionally checks the included originals. Neither produces an unqualified physical-truth badge.

## Validation and operational limits

`backend/tests/portable-verification.test.ts` checks exact legacy bytes containing whitespace, Unicode and exponential numbers across TypeScript signing and independent Python/OpenSSL verification. It also exports a real database-backed old snapshot after a later correction and verifies the older sequence/head, exclusion of the later record, unchanged original bytes, and independent trust. Eight separately authored Python fixtures exercise tampering, missing and omitted files, snapshot removal, wrong Proof/tenant/root, required snapshot replay rejection, stage inventory/ancestry, unsupported derivation references, compromised keys and stale trust. Existing signed-chain and trust-registry fixtures remain applicable.

Run the focused acceptance checks:

```bash
npm --prefix backend test -- --run tests/portable-verification.test.ts tests/signed-supplement-offline.test.ts
```

This proves local software conformance using synthetic data. Production signing-key setup, independent verifier distribution, an actual recipient review and controlled pilot remain operational gates. No production signing identity is generated by these tests.
