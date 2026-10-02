# Portable R&D export verification

No network, application login or signing secret is required. Supply public trust material acquired independently of the export. The bundle's own `trustList` is ignored as authority.

```sh
node verifier/rnd_bundle.mjs bundle.json --trust INDEPENDENT-TRUST.json
node verifier/rnd_bundle.mjs EXTRACTED-RESEARCH-DIRECTORY --trust INDEPENDENT-TRUST.json
node verifier/test_rnd_bundle.mjs
```

The independently supplied trust file uses existing `packproof.trust-list.v1` schema, generatedAt/expiresAt and unique key entries (keyId, algorithm, publicKeyPem, status; optional validFrom/validUntil). It must be current. Inactive/revoked/expired keys fail; this conservative research verifier does not grant historical exceptions from an unauthenticated signature-wrapper date. No future revocation knowledge can be established offline. Algorithms: P-256 ECDSA SHA256, RSA-PSS SHA256/32-byte salt (RSA ≥2048 bits), and explicitly pinned Ed25519.

The verifier preserves the existing root's exact frozen bytes and checks their SHA256 and signature; it does not recanonicalize legacy roots. It strictly parses JSON to reject duplicate keys. R&D records must use RFC8785 canonical serialization. It checks the root's Proof ID, every extension's signature/sequence/prior/root/tenant binding, full analysis input digest, declared sources and object versions, capture receipt inventory digest and optional signed client final-file inventory. Client-key verification does not imply hardware provenance.

A server-signed export snapshot binds export mode, audience, omissions, root, complete extension count/head/digest list, capture intents and receipts, signed reviewer annotations, enrollment event chains, native sidecars, original inventory and non-private derivative artifact inventory. Missing signed tails/receipts/artifacts or changed metadata fail against that snapshot. This establishes completeness **relative to that snapshot**, never completeness of all real-world evidence or future additions.

JSON-only checks return sourceBytesState `NOT_CHECKED`, completeByteCoverage false. With an extracted directory, every declared original/artifact must match its length and SHA256; path traversal and symlink escapes fail. Unrelated ordinary Proof evidence can be intentionally omitted from R&D exports; omitted root evidence IDs are reported and prevent a complete-byte-coverage claim. Witness receipts and ZK proofs remain `NOT_CHECKED` until their separate verifiers run with appropriate independently pinned trust.

Native sidecars are linked to the signed recording receipt and client final-file inventory. Acquisition/journal digests must match that inventory. With exported bytes, acquisition JSON must contain the exact signed frame descriptor and PGM frame bytes must match their digest, dimensions and exact header. Metadata-only verification cannot independently check acquisition contents. Concurrent luma sidecars never receive a decoded-video pixel-equivalence or sensor-attestation claim. Missing sidecars are detectable relative to the signed export snapshot; a sidecar that was never received cannot be asserted to exist.

Separate commands:

```sh
python verifier/rnd_verify.py witness-receipt.json --policy INDEPENDENT-WITNESS-POLICY.json --canonical-record RECORD.json
node research/privacy/zk/verify.mjs proof.json output.png INDEPENDENT-ZK-TRUST.json
```

Tests use real generated asymmetric signatures and original bytes. Mutations cover changed root, changed bytes, unsafe paths, wrong/cross-source references, sequence/prior changes, removed final extension/receipt/snapshot, changed signed export mode, malformed receipts, untrusted bundled keys, revoked/expired keys and source inventory changes. Scientific correctness, full scene authenticity, platform attestation and privacy completeness are outside this verifier's cryptographic result.
