# Additive integrity profile - engineering preview

This implements the format, KMS adapter, bounded package stream, independent verifier, durable signing state machine and protected-journal reconstruction portion of M2-03. It is **not activated in API routes or production workers**. The new migration is not applied to production or the paused isolated environment. Hosted authority/protection acceptance, authenticated key-history publication and the RFC 3161 provider path remain activation work. Existing production manifests, legacy signatures and package v1 remain unchanged.

## Frozen bytes and signing

`integrity/envelope-profile.ts` treats a recorded manifest as opaque bytes and checks its existing SHA-256. It never sends that manifest through the new serializer. Only the new envelope, coverage declaration and protected JWS header use RFC 8785, pinned to `canonicalize@5.1.0`.

The envelope's exact fields are `profile`, `proofId`, `recordType`, `recordId`, `manifestSchema`, `manifestPath`, `manifestSha256`, `coverageSha256`, `issuer` and `issuedAt`. Profile is `packproof.integrity-envelope.v1`; record type is CORE, STAGE or SUPPLEMENT. Issue time is the new issuer statement's time, never a fabricated historical capture time.

The separate envelope file uses flattened JWS JSON with exactly `protected`, `payload` and `signature`. Protected fields are exactly `alg=ES256`, a stable `kid`, and `typ=application/packproof-integrity+jws`. Header and payload are canonical UTF-8 JSON encoded with standard unpadded base64url. The KMS adapter sends SHA-256 of `protected + "." + payload` with `MessageType=DIGEST`, `SigningAlgorithm=ECDSA_SHA_256` and an exact key ARN. It checks the returned P-256 SPKI against independently configured public material. `asn1js@3.0.10` and `pkijs@3.4.1` perform DER-to-fixed-width conversion; `jose@6.2.13` verifies the complete returned JWS before it can be accepted. No homemade ASN.1 encoder is used.

The durable operation identity binds profile, Proof, record type, record ID, schema and frozen digest. The codec alone provides no database/outbox guarantee; `envelope-jobs.ts` supplies that state machine. Never call KMS within its database transactions.

## Durable work and reconciliation

Migration `093_integrity_envelope_jobs.sql` adds immutable request/result rows and a mutable delivery projection. It grants no runtime authority and rewrites no existing rows. The historical production migration operator remains pinned to migrations 088-092 and refuses this new inventory. Deploying migration 093 requires a new reviewed compatibility bridge and operator; the currently released production binaries are not declared compatible with it.

`enqueueEnvelopeFromRecovery` is an internal, explicit-cohort admission seam. It reads a DURABLE core/stage/supplement recovery event produced by the existing atomic domain outbox. It derives manifest bytes, original object versions and received record scope solely from that frozen snapshot. It never enumerates current evidence to repair a manifest. The request, lease projection, audit and ENVELOPE_REQUESTED recovery event commit together. Signing waits for that request event to become DURABLE. Replays preserve the same request; issuer, bucket, key or retention changes conflict instead of silently replacing it.

The worker claims a bounded lease under the current writer fence, then releases the transaction. It verifies the source journal signature and exact receipt version, preserves each frozen manifest, and stream-checks every original's exact bucket/key/version, size, digest and COMPLIANCE retention deadline. The S3 adapter uses conditional creation, explicit retention, a SHA-256 upload checksum and expected bucket owner. It has no original-copy, latest-media, retention-shortening or deletion operation. Later stages with insufficient original retention fail; automatic retention extension remains M3-06 work.

KMS consumes the new envelope only after those checks. A conditional object keyed by operation ID chooses the first stored result if leases overlap. Every contender verifies that stored winner against independently supplied issuer/key history. Short lease renewals occur between bounded external calls. The final transaction rechecks the unexpired lease and writer generation, inserts the immutable result/receipt, appends audit, and enqueues ENVELOPE_SIGNED. A stored result is SIGNED_PENDING_DURABILITY until that event is independently protected; only then does internal status return READY. Neither state changes the frozen core or a finalize replay.

Lost object responses, database rollback after publication, expired leases and fenced workers reconcile from the same stored candidate. The request and accepted result enter complete Proof recovery snapshots; fresh restore verifies their source binding, JWS, coverage and exact object protection using separately supplied trust. It rebuilds pending deliveries without stale lease tokens and restores accepted result bytes without resigning. Restored traffic and writers remain closed. If those verifier/storage dependencies are missing, restore refuses to accept envelope records.

These routines are internal and unscheduled. Before hosting them, wire admission/status/export through current Proof authorization, select an explicit cohort and cutover, configure independently authenticated key history, provision the separately scoped worker key and storage permissions, and run the crash/fence/restore acceptance against those actual roles. Legacy stage/supplement signing still needs its own short-transaction boundary review. The preview does not claim those deployment gates passed.

## Coverage and package

`packproof.integrity-coverage.v1` binds the same Proof/record identity to artifact paths, kind, digest, byte size, required flag, exact bucket/key/version and source relationship. A derivative must reference a declared ORIGINAL. A stage commitment must reference a required MANIFEST artifact with the same digest. Explicit omissions make coverage partial; no received declaration rules out unseen later stages.

The additive `.pkpr` transport is `packproof.signed-proof-package.v2`. Its fixed files are `package.json`, `integrity/envelope.jws.json` and `integrity/coverage.json`, followed by the declared artifact paths. The streaming builder consumes a stored, verified JWS, calls only the exact-version reader, checks every byte count/hash and reauthorizes throughout delivery. A version mismatch, revoked grant or incomplete source prevents a complete ZIP directory. Export never generates another signature.

This format intentionally differs from the frozen manifest schema. Existing package v1 exports and the legacy verifier path stay available. Stage/source commitments describe the included scope; live retention remains a separately audited storage property.

## Independent trust and results

Verifier 1.4.0 adds `envelope.py`, using `rfc8785==0.1.4` and `cryptography==50.0.2`. It imports no backend code, uses a different cryptographic implementation and accepts no key or registry from the ZIP. Install `requirements-envelope.txt` in a dedicated environment, then:

```sh
python verifier/verify.py proof.pkpr \
  --envelope-trust independently-authenticated-issuer-keys.json \
  --expected-proof-id proof_... \
  --expected-manifest-sha256 <independently-known-digest>
```

The independently authenticated trust file has exactly `schema=packproof.envelope-trust.v1`, `issuer`, `publishedAt`, `nextReviewAt` and `keys`. Each key has `keyId`, `publicKeyPem`, `status`, `validFrom`, nullable `validUntil` and nullable `statusEffectiveAt`. Keys are P-256. ACTIVE requires no status-change date; RETIRED and COMPROMISED require one within the published snapshot. Retired keys can verify signatures issued within their historical validity. A self-asserted issue date cannot rescue a compromised key. Duplicate identities, unsupported algorithms, future registry dates and issuer substitution fail closed. Key-history distribution and authentication remain an operational gate; the local-file option means the verifier operator has explicitly pinned that material.

REVOKED is a distinct supported status and also requires a dated change; it does not become trusted by claiming an earlier issue time. `envelope-trust.ts` authenticates the existing signed public-key registry against separate authority pins on every lookup. The deployment configuration explicitly binds that registry to the issuer because the older signed registry schema has no issuer field. Its public snapshot preserves ACTIVE, RETIRED, REVOKED and COMPROMISED labels. The KMS wrapper requires an active current key before and after each sign, a matching pinned SPKI, the configured issuer and a fresh actual issue time. It refuses stale, tampered or substituted registry data. This supplies the runtime trust adapter; authenticated public distribution and deployed rotation/compromise acceptance remain operational work.

The result reports `hashIntegrity`, `issuerSignature`, `timestamp`, `coverage`, `keyStatus` and `truthOfRecordedScene=NOT_ASSESSED`. It also reports trust-snapshot expiry and `currentRevocationKnowledge=UNAVAILABLE_OFFLINE`. A mathematically valid signature does not hide missing artifacts, stale trust or a compromised key. No trusted-time claim is enabled: the current exporter emits NOT_PRESENT; PENDING is reported without upgrading it to VALID. Any unsupported VALID token assertion is rejected. RFC 3161 token storage, certificate validation and provider configuration remain required work.

## Verification evidence and activation boundary

The focused suite covers RFC 8785 number/string/property-order vectors, legacy byte preservation, DER widths, wrong keys, double hashing, duplicate JSON, missing originals, modified artifacts, stage substitution, issuer substitution, retirement/compromise, stale trust, timestamp claims, exact object versions and export revocation. Cross-language tests create Node signatures and verify the bounded ZIP with Python. Synthetic media and object identities are explicitly test data.

All 26 focused checks passed locally, including a recorded real KMS signature obtained under the actual isolated API workload role. Both JOSE and Python independently verified that signature. The [KMS receipt](envelope-kms-evidence-2026-10-22.json) binds the task, key, digest, request ID and public fixture; its object identity is explicitly synthetic and is not a storage-preservation assertion. The 32 legacy verifier tests also passed. The CLI registry test now uses its running Python interpreter, which avoids the inaccessible Windows `python3` alias without changing verification behavior. Backend typecheck and the production-dependency audit passed with no findings.

The durable worker and restore tests use real domain finalization and PostgreSQL-compatible transactions with explicit synthetic storage/key adapters. The focused CI workflow additionally runs overlapping lease contention on independent PostgreSQL pools. S3 adapter tests check conditional-write winners, exact version reads, insufficient protection, modified bytes and bucket scope. These are engineering tests, not deployed Object Lock or device evidence. Hosted SEAL-02/03/04 acceptance, production protection and current key-history distribution still gate activation. A successful codec or synthetic KMS signature does not satisfy the M2 merchant pilot.

At source `7cdb4c368670f8428c0c65cce24add5568624f26`, focused CI passed all 53 TypeScript checks and 32 legacy Python checks. The overlapping-lease case ran on independent PostgreSQL pools; all eight fresh-recovery tests passed. Existing partner foundation/packaging gates also passed. Exact run and job references and the remaining deployment boundaries are recorded in [the durable-envelope engineering receipt](envelope-durable-evidence-2026-10-22.json).

Primary references: [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785), [canonicalize](https://github.com/erdtman/canonicalize), [JOSE](https://github.com/panva/jose), [PKIjs signature conversion](https://pkijs.org/docs/api/globals/#createecdsasignaturefromcms), [KMS Sign](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html), [Python RFC 8785](https://pypi.org/project/rfc8785/), [cryptography](https://cryptography.io/).
