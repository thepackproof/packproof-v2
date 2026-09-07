# Proof Anywhere verifier 1.1.0

Download `verify.py` separately from the PackProof repository/release. It is a standalone, read-only Python program; it does not import the PackProof server, log in, extract archive paths, execute package contents, fetch keys, or upload media. Python 3.10+ is required. Signature checks additionally require an installed OpenSSL executable; missing OpenSSL returns `SIGNATURE_UNCHECKED`.

```bash
python3 verify.py proof.zip --trust-list independently-obtained-trust.json
```

For the signed, dated registry format, obtain the authority's public PEM and key identity through an independent trusted channel:

```bash
python3 verify.py proof.zip \
  --trust-registry signed-registry.json \
  --trust-authority-key independently-pinned-authority.pem \
  --trust-authority-key-id packproof-registry-authority
```

All three options are required together. The verifier verifies the registry signature before using any listed signing key. It never reads an authority key or registry from the ZIP, and it does not fetch keys or later revocations. `--trust-list` retains its existing explicitly trusted local-input semantics and cannot be combined with `--trust-registry`.

For an existing unsigned Proof, obtain its manifest SHA-256 separately and compare it explicitly:

```bash
python3 verify.py proof.zip --expected-manifest-sha256 <64-hexadecimal-characters>
```

This compares the frozen record and every included original against that record. It does not make an unsigned record signed. The program returns JSON suitable for a local viewer or terminal. Add `--html-report report.html` to create a human-readable local report with the result, snapshot identity, signature/trust state, source file names, SHA-256 inventory and explicit omissions. Open that HTML file in an ordinary browser without logging in. It contains escaped text and static CSS only: no JavaScript, archive content links, active media, extraction, external assets, or network requests. Its content security policy denies active/network content, and existing destination files are never overwritten. The report itself is an unsigned presentation of the check, so retain the original ZIP and trusted verifier when reproducibility matters. Exit code `0` means a complete record verified against a separately provided digest or an active key in a fresh trust list. Exit `2` means a clear qualification requires review (unsigned, unknown/revoked key, invalid signature, stale trust, omissions, or unavailable signature tooling). Exit `1` means malformed, missing, modified, or unsupported package data. Always inspect `status`, `signature`, `trust`, and `omissions`; do not collapse all nonzero results into “fraud.”

| Outcome | Meaning |
| --- | --- |
| `VERIFIED` | Original bytes match the frozen snapshot; signature verifies under a trusted active or historically valid retired key and a fresh trust snapshot. |
| `VERIFIED_INDEPENDENT_DIGEST` | Original bytes match an independently supplied root digest. No signature is claimed. |
| `UNSIGNED` | Internally consistent hash-only record; origin has not been independently established. |
| `UNKNOWN_KEY` | A signature exists but its key is absent from the independently supplied trust list. |
| `REVOKED_KEY` | The local trust list marks the signing key revoked; the verifier does not accept it. |
| `COMPROMISED_KEY` | The authenticated registry reports compromise. Even a claimed signature date before the incident requires review. |
| `KEY_OUTSIDE_VALIDITY` / `INVALID_SIGNING_TIME` | The signature's reported time is outside the key's effective dates, after retirement, in the future, or malformed. |
| `UNTRUSTED_REGISTRY` / `INVALID_TRUST_REGISTRY` | The registry cannot be authenticated under the independent authority pin, or its schema/dates/statuses are invalid. No registry key establishes trust. |
| `TRUST_STALE` / `TRUST_NOT_YET_VALID` | Signature math may pass, but the local list is outside its stated freshness window. |
| `INVALID_SIGNATURE` | The signature did not verify with the independently supplied matching key. |
| `MISSING_FILES` | A required included archive entry is absent. |
| `OMITTED_FILES` | The exporter explicitly declared unavailable/excluded original media; excluded bytes were never verified. |
| `DISCLOSURE_ONLY` | Only the recipient view and its included byte inventory are self-consistent. The root and withheld originals were not verified. |
| `MODIFIED_FILES` | A digest, size, CRC, or frozen representation disagrees. |
| `UNSUPPORTED_VERSION` / `UNSUPPORTED_ALGORITHM` | This release cannot interpret that format or signature algorithm. |
| `UNSAFE_ARCHIVE` | Duplicate/unsafe names, entry types, compression, counts, or size exceed the parser contract. |

## Trust-list contract and rotation

The signed-registry envelope is `{registry,signature}`. `registry` has exactly `version:1`, `domain:"PACKPROOF_SIGNING_TRUST_REGISTRY"`, `publishedAt`, `nextReviewAt`, and `keys`. Every registry key has exactly `keyId`, `algorithm`, `publicKeyPem`, `validFrom`, `validUntil`, `status`, `statusEffectiveAt`, and `reason`. Timestamps include a timezone; `validUntil`, `statusEffectiveAt`, and `reason` can be null where applicable. `status` is `ACTIVE`, `RETIRED`, `REVOKED`, or `COMPROMISED`; unknown statuses and duplicate identities fail closed. Non-active keys require `statusEffectiveAt`, and effective status cannot postdate registry publication. `signature` has `algorithm`, the independently pinned authority `keyId`, `signatureBase64`, and `signedAt`, and covers the UTF-8 `packproof.sorted-json.v1` canonical registry object. Key algorithms are `ECDSA_SHA_256` or `RSASSA_PSS_SHA_256`.

For an active or retired key, the reported signing date must be within its inclusive `validFrom`/`validUntil` range and not in the future. A retired key also requires signing on or before `statusEffectiveAt`. A revoked or compromised key always requires review: a self-asserted historical signing date cannot establish that a signature predates compromise. The verifier keeps signature mathematics separate: signed-registry checks may report `signatureVerified:true` alongside `REVOKED_KEY` or `COMPROMISED_KEY`, while `signature.keyTrustedAtSnapshot` is false. A stale registry can likewise preserve the math result but cannot produce overall `VERIFIED`. `trust.currentRevocationKnowledge` is always `UNAVAILABLE` offline. The root's signature timestamp is neither independently attested filming time nor a trusted timestamp authority receipt.

The closed registry schema deliberately restricts canonicalization to fixed ASCII member names, strings, nulls, arrays, and integer version 1, avoiding cross-language floating-point or numeric-member-name differences. Unknown additional fields are rejected until a schema/version update explicitly supports them. Legacy manifest canonical bytes are still verified verbatim without Python reserialization.

A trust list has schema `packproof.trust-list.v1`, timezone-qualified `generatedAt` and `expiresAt`, and a `keys` array. Every key contains `keyId`, `algorithm` (`ECDSA_SHA_256` or `RSASSA_PSS_SHA_256`), `publicKeyPem`, and `status` (`ACTIVE` or `REVOKED`). `keyId` must match the recorded signature and be unique. A trust list is an explicitly trusted local input, **not a self-authenticating file**. Authenticate its origin and checksum through an independent channel before use. Keys included in a ZIP are never loaded as trust.

Key rotation adds the new public key while retaining previous verification keys. Stop issuing signatures with retired private keys. Publish compromise revocations as `REVOKED`, retain the key entry, and refresh the trust list through the same authenticated channel. An offline verifier cannot discover revocations published after its last update; `trust` always reports the local list dates and this limitation. The operating system's current clock determines freshness. The recorded `signedAt` is metadata, not an independent trusted timestamp, and is never treated as filming time or used to defeat a revocation.

The API signing runtime and operator configuration are documented in [`docs/MANIFEST_SIGNING_OPERATIONS.md`](../docs/MANIFEST_SIGNING_OPERATIONS.md). The public trust endpoint is `/.well-known/packproof-trust.json`, when configured; its HTTPS origin and public-key identity still need independent authentication.

No production key is included in this source release. Existing unsigned manifests remain unsigned and immutable. Configuring production signing, publishing an authenticated trust list, and distributing the verifier release through the chosen independent channel are operational release gates; do not create a test key and advertise it as the PackProof production identity.

## Public ZIP format

The transport is ordinary ZIP (`.zip`); old `.pkpr` filenames remain readable because the contents, not the extension, determine format. `package.json` retains `packproof.proof-package.v1`. `archive.json` identifies `packproof.proof-archive.v1`, the root snapshot, export time, participant disclosure context, explicit omissions, source file locations, and optional derivative lineage. No verifier executable is bundled in the export.

- `manifest.json`: exact frozen canonical UTF-8 bytes. The signature covers only these bytes, using SHA-256 with DER ECDSA signatures or RSA-PSS/SHA-256 with 32-byte salt.
- `package.json`: exact canonical JSON string, parsed representation, SHA-256 and optional signature. All representations must agree.
- `integrity/evidence.json`: one entry per frozen original. Included entries name a file; omitted entries name no file and state `UNAVAILABLE` or `WITHHELD_BY_SCOPE`, the expected SHA-256 and size. The canonical manifest is never rewritten to hide an omission.
- `lifecycle/stages.json`: finalized stage inventory with exact stage manifests and separately checked media. Every stage references the root and any preceding stage; a missing or cyclic predecessor fails verification.
- `integrity/signatures.json`: repeats the root signature and describes signing availability. It must agree with the package signature.
- `integrity/hashes.json`: SHA-256 of every file except itself. Legacy archives may leave `README.txt` outside this inventory. Unexpected unindexed entries fail verification.
- `shipping.json`, `events.json`: later, append-only supplemental information. Their archive hashes establish **self-consistency only**; they are not authenticated by the root signature. Editing these and recomputing an untrusted export inventory cannot be detected without a separately trusted export digest. The verifier always reports this boundary.

Recipient exports use the distinct `packproof.disclosure-package.v1` schema: `view.json`, selected `media/` files, and the hash inventory. They contain no canonical manifest, original object keys, excluded original hashes, or hidden media. The verifier reports `DISCLOSURE_ONLY` with exit `2`; `evidenceVerified` is zero because canonical original identity has not been independently established. Lineage for redacted originals is visibly withheld by scope. Any unexpected extra file in a disclosure archive fails verification.

Full exports require participant authorization. They can contain sensitive fields; a recipient-scoped projection must be a distinct disclosure export and must never masquerade as the complete root manifest. Revoking online access cannot recall already downloaded bytes. Derivatives are optional aids; their lineage must identify source hash/version, transformation/version, derivative hash, and omitted intervals. This exporter currently includes canonical originals and lifecycle originals, and declares an empty derivative inventory.

## Canonical bytes and vectors

The existing `packproof.sorted-json.v1` scheme is retained, **not relabeled RFC 8785**. It recursively sorts object property names with JavaScript UTF-16 ordering, retains array order, then uses ECMAScript JSON serialization. JavaScript's integer-index property ordering still applies; JSON strings, Unicode, negative zero, and exponential numbers retain existing serialization semantics. Undefined object values are omitted; the committed JSON contract contains no undefined or non-finite numbers.

The portable verifier hashes/signs the exact stored canonical bytes rather than reserializing Python numbers into a potentially different representation. It separately parses strict UTF-8 JSON (duplicate keys and non-finite literals rejected) and checks package, parsed manifest, root identity, and raw canonical string agreement. `canonical-vectors.json` publishes deterministic inputs, expected bytes and SHA-256 values, including numeric key ordering, Unicode, escaping and number formatting. Backend tests verify the same vectors in TypeScript and Python and verify TypeScript-generated signed ZIP fixtures with the independent Python/OpenSSL implementation.

Parser limits: 220 MiB compressed input and total expanded data; 4,096 entries; 8 MiB per JSON file; 1,024-byte ASCII entry names; maximum 200:1 compression ratio; stored/deflated regular files only. Traversal, absolute/Windows paths, duplicate names, symlinks, encryption and unindexed entries are rejected. Archive entries are never extracted. OpenSSL only receives independently supplied public-key text and opaque manifest/signature bytes through fixed argument lists.

## Release validation

From the repository root:

```bash
npm --prefix backend test -- --run tests/proof-anywhere.test.ts tests/proof-package.test.ts
python3 -B -m unittest discover -s verifier -p 'test_*.py' -v
npm --prefix backend test -- tests/signed-registry-offline.test.ts
```

Signed-registry tests exercise actual Python/OpenSSL verification for ECDSA and RSA-PSS authorities, corrupt registries, incorrect or missing external pins, unknown keys, stale/future snapshots, retirement windows, revoked/compromised keys with backdated claimed signatures, invalid manifest signatures and archive-included trust material. A TypeScript-generated signed fixture checks canonical interoperability, including Unicode text. The Python tests are also run by the backend test suite.

Fixtures cover valid signature verification, modified media even after rewriting the ZIP hash inventory, missing files, unknown/forged/revoked keys, unsigned records, stale trust, unsupported versions, deliberate omissions, traversal, Windows paths, duplicate entries and compressed-size abuse. Tests run with deliberately unusable HTTP proxy endpoints; the verifier implementation has no network client. A physical air-gap and independent reviewer usability trial remain separate deployment/pilot validation tasks.
