# Offline surface export verification

`verifier/surface-verify.py` verifies a `surface-export/1` JSON snapshot without networking, image decoding or executing export content. It is a separate checker for the experimental extension inventory; the existing `verifier/verify.py` remains the full ordinary Proof ZIP verifier.

Run from the repository root:

```sh
python3 verifier/surface-verify.py surface-export.json \
  --expected-proof-id proof_identifier \
  --expected-root-sha256 INDEPENDENT_FROZEN_ROOT_SHA256 \
  --expected-extension-head-sha256 INDEPENDENT_RECEIVED_HEAD_SHA256
python3 verifier/surface-test.py
```

Replace the uppercase placeholders with actual 64-character lowercase SHA-256 values obtained through an independent authenticated channel. Copying an expected digest from the same untrusted export checks self-consistency only. Supplying an older head explicitly verifies that older received snapshot; it cannot reveal unseen later events.

## What is checked

- Exact UTF-8 `canonicalJson` bytes for the root, enrollment/observation/comparison records, analyses, optional supplied templates and every extension. The verifier does not reserialize and invent new signing bytes.
- Proof IDs, record kinds/IDs, enrollment and observation digest links, source digests/lengths, analysis-to-record commitments, extension order/ancestry and subject digest references.
- A supplied independent root digest remains equal to the frozen root. A changed root fails even if an attacker recomputes its local digest. Surface entries created before finalization may explicitly have no root; they do not retroactively become root evidence.
- A supplied independent head detects omitted/truncated/reordered/duplicated extensions. Every record and analysis must be committed by the included chain.
- Optional source files match their exact byte size and digest. Only bounded, regular files beneath `--media-dir` are accepted; traversal, absolute paths and symbolic links fail.
- Optional signatures against a separately authenticated fresh trust-list using the existing offline signature checker. Export-included keys never establish trust. Unsigned R&D extensions remain explicitly unsigned.

The default backend export contains source commitments with `mediaPath: null`; it does **not** contain original pixels. `availability: available` means storage metadata was present when exported, not that the verifier received or validated those bytes. Download each authorized original from `/proofs/{proofId}/surfaces/media/{sourceId}`, place it in a private directory, set only the corresponding inventory `mediaPath` to its relative filename, and pass `--media-dir`. Preserve all committed canonical strings without edits. The source metadata inventory can be enriched with local paths because its immutable facts are checked against the record/extension commitments.

Private templates and raw match scores are withheld from ordinary participant exports. An authorized researcher with the retained private worker result may supply `--private-artifact private-result.json` (repeat for multiple jobs). The verifier hashes its exact `artifactCanonicalJson` and each template's exact `canonicalJson`, then checks these against the result and role-specific template digests committed in the analysis. It never prints descriptors or scores. The preserved canonical strings avoid Python/JavaScript number serialization differences such as `1.0` versus `1`.

A withheld template is an explicit omission; an artifact hash is not a replacement for the artifact. Full numerical matcher replay also requires the recorded worker/runtime/profile artifacts and source images. An optional `--expected-tenant-id` enforces the recorded tenant scope; personal Proofs use their explicit `account:` scope.

## Result semantics

| Report field | Meaning |
| --- | --- |
| `INTEGRITY_CHECKED` | Included commitments passed and an independent root/head pin or authenticated extension signature anchor was supplied |
| `SELF_CONSISTENT_UNTRUSTED` | Included hashes agree, but no independent trust anchor was supplied |
| `INVALID_EXPORT` | Malformed data, mismatched bytes/binding, unsafe media path or invalid trusted signature |
| `rootUnchangedAgainstIndependentDigest` | Exact frozen bytes match the supplied independent root pin |
| `extensionAuthentication` | Separates authenticated signatures or independently pinned extension head from extension self-consistency; a root pin alone does not authenticate later unsigned entries |
| `completeOriginals` | Every declared source's actual bytes were provided and matched; says nothing about scene truth |
| `omittedTemplateDigests` | Declared derived artifacts unavailable for independent replay |
| `physicalAccuracy: NOT_EVALUATED` | The verifier does not test optics, physical identity, replay resistance, closure or contents |

Exit codes are 0 for integrity checked, 2 for untrusted self-consistency and 1 for invalid/unreadable input. Missing originals or templates are reported even when a trusted commitment check succeeds. Read the completeness/omission fields before treating the export as reproducible evidence.

Protocol test fixtures use clearly synthetic opaque bytes. Their passing results cannot qualify a camera, material, matcher or security claim.
