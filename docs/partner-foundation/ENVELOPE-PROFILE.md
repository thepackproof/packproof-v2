# Additive integrity profile - engineering preview

This implements the format, KMS adapter, bounded package stream and independent verifier portion of M2-03. It is **not activated in API routes, the finalization transaction or production workers**. The durable signing-job/preservation integration, recovery coverage, authenticated key-history publication and RFC 3161 provider path must be completed before activation. Existing production manifests, legacy signatures and package v1 remain unchanged.

## Frozen bytes and signing

`integrity/envelope-profile.ts` treats a recorded manifest as opaque bytes and checks its existing SHA-256. It never sends that manifest through the new serializer. Only the new envelope, coverage declaration and protected JWS header use RFC 8785, pinned to `canonicalize@5.1.0`.

The envelope's exact fields are `profile`, `proofId`, `recordType`, `recordId`, `manifestSchema`, `manifestPath`, `manifestSha256`, `coverageSha256`, `issuer` and `issuedAt`. Profile is `packproof.integrity-envelope.v1`; record type is CORE, STAGE or SUPPLEMENT. Issue time is the new issuer statement's time, never a fabricated historical capture time.

The separate envelope file uses flattened JWS JSON with exactly `protected`, `payload` and `signature`. Protected fields are exactly `alg=ES256`, a stable `kid`, and `typ=application/packproof-integrity+jws`. Header and payload are canonical UTF-8 JSON encoded with standard unpadded base64url. The KMS adapter sends SHA-256 of `protected + "." + payload` with `MessageType=DIGEST`, `SigningAlgorithm=ECDSA_SHA_256` and an exact key ARN. It checks the returned P-256 SPKI against independently configured public material. `asn1js@3.0.10` and `pkijs@3.4.1` perform DER-to-fixed-width conversion; `jose@6.2.13` verifies the complete returned JWS before it can be accepted. No homemade ASN.1 encoder is used.

Persist the first accepted envelope/JWS under a durable operation identity bound to Proof, record type, schema and frozen digest. Replays must return it. The adapter deliberately does not pretend to provide that database/outbox guarantee itself. Never call it within the domain transaction or expose this preview as signing-ready before the durable worker integration exists.

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

The result reports `hashIntegrity`, `issuerSignature`, `timestamp`, `coverage`, `keyStatus` and `truthOfRecordedScene=NOT_ASSESSED`. It also reports trust-snapshot expiry and `currentRevocationKnowledge=UNAVAILABLE_OFFLINE`. A mathematically valid signature does not hide missing artifacts, stale trust or a compromised key. No trusted-time claim is enabled: the current exporter emits NOT_PRESENT; PENDING is reported without upgrading it to VALID. Any unsupported VALID token assertion is rejected. RFC 3161 token storage, certificate validation and provider configuration remain required work.

## Verification evidence and activation boundary

The focused suite covers RFC 8785 number/string/property-order vectors, legacy byte preservation, DER widths, wrong keys, double hashing, duplicate JSON, missing originals, modified artifacts, stage substitution, issuer substitution, retirement/compromise, stale trust, timestamp claims, exact object versions and export revocation. Cross-language tests create Node signatures and verify the bounded ZIP with Python. Synthetic media and object identities are explicitly test data.

All 26 focused checks passed locally, including a recorded real KMS signature obtained under the actual isolated API workload role. Both JOSE and Python independently verified that signature. The [KMS receipt](envelope-kms-evidence-2026-10-22.json) binds the task, key, digest, request ID and public fixture; its object identity is explicitly synthetic and is not a storage-preservation assertion. The 32 legacy verifier tests also passed. The CLI registry test now uses its running Python interpreter, which avoids the inaccessible Windows `python3` alias without changing verification behavior. Backend typecheck and the production-dependency audit passed with no findings.

Before enabling the profile, complete SEAL-02/03/04: atomic job creation with the core result, required preservation receipts, leased/retryable worker execution, first-result persistence, protected-journal reconstruction and crash reconciliation. Also finish real production protection and current signing-key-history distribution. A successful codec or synthetic KMS signature does not satisfy those gates or the M2 merchant pilot.

Primary references: [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785), [canonicalize](https://github.com/erdtman/canonicalize), [JOSE](https://github.com/panva/jose), [PKIjs signature conversion](https://pkijs.org/docs/api/globals/#createecdsasignaturefromcms), [KMS Sign](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html), [Python RFC 8785](https://pypi.org/project/rfc8785/), [cryptography](https://cryptography.io/).
