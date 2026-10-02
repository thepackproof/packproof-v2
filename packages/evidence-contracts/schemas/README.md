# Research wire contracts

These schemas describe research records only. They never replace the ordinary Proof root manifest schema or serializer. Keep existing root canonical bytes byte-for-byte when verifying or exporting them.

| Record | Signed payload schema | Detached wrapper |
| --- | --- | --- |
| Completed analysis extension | `extension.schema.json`, embeds `analysis.schema.json` | `extension-record.schema.json` |
| Capture intent | `capture-intent.schema.json` | `signed-record.schema.json` |
| Sealed capture receipt | `capture-receipt.schema.json` (`capture-session` alias) | `signed-record.schema.json` |
| Late native sidecar receipt | `capture-sidecar-receipt.schema.json` | `signed-record.schema.json` |
| Reviewed derivative grant / audit event | `derivative-grant.schema.json` / `derivative-grant-event.schema.json` | `signed-record.schema.json` |
| Platform challenge / verification | `platform-challenge.schema.json` / `platform-assurance.schema.json` | `signed-record.schema.json` |

`signature.schema.json` describes the backend detached signature fields. It is not a trust policy. Keys supplied within an export never establish trust; verification requires an external pinned policy. `assertSignedRecord` is structural and canonical validation only, and does not verify a digest or signature. The standalone portable verifier performs those cryptographic checks.

The database and detached wrapper `digest` use **64 lowercase hexadecimal characters without a prefix**, preserving the existing backend representation. Inside new signed analysis/extension payloads, `rootManifestDigest`, `previousDigest`, `inputDigest`, method commitments and analysis `sourceRefs[].sha256` use **`sha256:` plus 64 lowercase hexadecimal characters**. There is no implicit string normalization before signing. `previousDigest` is `null` only for sequence 1; later entries name the preceding detached record digest with the prefix. The extension's embedded analysis must have the same Proof, tenant and root commitment.

Capture receipts carry `committed-source.schema.json` records using the raw persisted SHA-256 and subject/leg/package bindings. Analysis source references use `source.schema.json`. These are deliberately named distinct representations of the same exact-byte commitment; callers must compare digest values and inventory identities explicitly. The capture subject contains `id/proofId/tenantId/legId/packageInstanceId`; the analysis subject has `shipmentLegId/packageInstanceId` and optional product identity.

`observation.schema.json`, `comparison.schema.json`, `derivative.schema.json` and `capability.schema.json` define normalized interchange records. Feature-specific worker output stays under `analysis.details`, linked to `sourceRefs`, and is not claimed to implement those normalized records unless explicitly converted and validated. Operational job state and evidential finding remain separate. A failed or incomplete operation cannot assert a positive physical finding.

Dependency-free runtime assertions cover analysis, source references, completed extensions and detached wrappers. They reject missing or unknown fields, malformed source commitments, wrong scalar types, duplicate source IDs, cross-Proof references and extension/analysis binding mismatches. They do not supply scientific qualification, verify source bytes or assert physical truth. Tests cover emitted backend field shapes and adversarial mutations against both assertions and the declared schema vocabulary.

Late sidecar receipts bind the parent receipt, native inventory and original media hash without modifying the earlier capture receipt. `native-frame.schema.json` describes concurrent luma acquisition; it never asserts pixel equivalence to a decoded recording frame. Metadata sidecars remain `CAPTURE_METADATA` and are not eligible visual evidence. Receipt services and portable verification additionally compare the subject, hash, file and frame relationships and exact bytes; schema shape alone is insufficient.

Signed derivative grant/event records contain only public scope, byte/recipe/review commitments and audit fields. Bearer secrets and their database hashes are excluded by schema; expiry, revocation, consent and exact review validity still require the grant service.
