# F07-06: supported-profile performance and cryptographic review packet

Status: a bounded repeated measurement is complete; independent cryptographic review,
target deployment performance/cost acceptance and public reliance remain **pending**.
No supported circuit was widened and no production or pilot was enabled.

## Measured execution

The [benchmark](../../../research/qualification/privacy/performance-preflight.mjs)
uses the actual existing circuit and verifier, two workers, fresh compilation cache,
three distinct synthetic RGB8 images/masks per supported profile and independent random blindings. Each
proof is verified through `verifyBundle`; only synthetic public bundles, derivatives
and ephemeral public test trust material are saved. No private opening or signing key
is exported. Trust generated for a synthetic benchmark is not external authority.

On 2026-10-12 at 01:29:25–01:30:33 UTC, Node 22.23.2 / o1js 2.15.0 on Windows x64,
Intel Core i9-14900K produced the following observations:

The second supported profile was measured once at 01:34:46–01:36:10 UTC on the same
runtime and machine, with the unchanged harness and its own fresh compilation cache.

| Observation | 4×4 | 8×8 |
| --- | --- | --- |
| Fresh-cache compilation | 20.378 seconds | 28.153 seconds |
| Proof 1 / verification 1 | 17.025 / 1.633 seconds | 17.374 / 1.761 seconds |
| Proof 2 / verification 2 | 11.714 / 0.829 seconds | 15.542 / 1.896 seconds |
| Proof 3 / verification 3 | 14.134 / 1.270 seconds | 17.959 / 1.366 seconds |
| Descriptive proving min / median / max | 11.714 / 14.134 / 17.025 seconds | 15.542 / 17.374 / 17.959 seconds |
| Descriptive verification min / median / max | 0.829 / 1.270 / 1.633 seconds | 1.366 / 1.761 / 1.896 seconds |
| Compact serialized proof member | 30,151 bytes each | 30,340 / 30,340 / 30,338 bytes |
| Compact serialized full bundle | 31,536 / 31,536 / 31,537 bytes | 31,998 / 31,999 / 31,994 bytes |
| Reported process high-water resident memory | 680,628 KiB (about 664.7 MiB) | 780,028 KiB (about 761.7 MiB) |
| Existing verifier outcomes | 3 / 3 accepted | 3 / 3 accepted |

This is **three observations per profile**, not p95, reliability, an SLA, aggregate system memory
or a cloud/device cost estimate. Later proofs reuse the compiled circuit in one process.
Windows process RSS is not the backend's sampled Linux memory limit or an OS sandbox
qualification. The result cannot be extrapolated to full-size photos, video or other
profiles. Previous single-run evidence remains separate; no performance improvement
over a different host/run is claimed. This is a local comparison of observed resource
costs, not monetary costing or an equal-work performance ranking.

The byte counters describe compact `JSON.stringify` output: `proofJsonBytes` counts
the proof member and `bundleBytes` counts the full bundle. Saved `proof.json` contains
the full bundle formatted with indentation and a newline, so its file size is larger.
The receipt checker separately reports that actual file size and recomputes both
compact counters from the stored JSON; these quantities are not interchangeable.

Both receipts identify repository base `c420de30a4d7f0be34356ee8da1639216dc80ee3`,
explicitly records a dirty worktree containing the new qualification preparation, and
hashes the exact circuit, verifier, harness and lockfile. The benchmark harness was
not changed after the successful run. An earlier attempt compiled but produced zero
samples because loading a second CommonJS o1js instance gave field types incompatible
with the existing circuit's ESM instance. Its failure receipt is retained. Loading the
same ESM entry as the existing circuit fixed the harness; the successful receipt is
a separate attempt, not a relabeled failure.

Evidence directory supplied with the handoff:
`privacy-performance-4x4-final/` and `privacy-performance-8x8-final/` each contain
`performance.json` and three public sample directories;
`privacy-performance-4x4/performance.json` retains the initial failed attempt.
Compilation cache files are local build material, not qualification evidence.

## Reproduce or inspect without repeating expensive proving

The offline receipt checker needs only Node and verifies the measurement structure,
descriptive summaries, explicit nonqualification fields and exact saved artifact hashes.
It does not independently repeat cryptographic verification or approve cryptography.

```sh
node --test research/qualification/privacy/performance-report.test.mjs
node research/qualification/privacy/performance-report.mjs /path/to/performance.json
```

For an explicitly needed new measurement, install the existing pinned runtime and use
a new output directory with an existing parent. Only existing 4×4 or 8×8 profiles and
one to three samples are admitted; the harness has a four-minute wall-clock watchdog.
This harness is a synthetic local measurement tool, not a hostile-media sandbox.

```sh
cd research/privacy/zk
npm ci --ignore-scripts --no-fund --no-audit
cd ../../..
node research/qualification/privacy/performance-preflight.mjs --size 4 --samples 3 --output /private/new-measurement
```

## Exact independent cryptographic review scope

Give a qualified reviewer the source and dependency lock, the existing adversarial
proof tests, actual supported-profile receipts and the following narrowly stated claim:
the proof binds a trusted processor's committed RGB8 pixels to an exact same-size
derivative whose public mask replaces selected channels with zero and leaves the other
channels unchanged. Only fixed 4×4 and 8×8 opaque images are supported.

| Review subject | Decision/evidence requested |
| --- | --- |
| Circuit constraints | Width/height and format/transform version binding; UInt8 range and Boolean mask constraints; complete equality constraints for zeroed and unchanged channels; public input ordering and serialization. |
| Commitments and blinding | Poseidon domains, dimension/version separation, pixel packing, random blinding entropy and reuse behavior; what public masks/digests reveal. |
| Framework and keys | Pinned o1js Kimchi/Pasta parameters and dependencies, verification-key generation/registry/hash binding, upgrade policy and claimed security assumptions. No unsupported fixed security level is asserted here. |
| Trusted extraction | Ed25519 source-binding issuer, canonical record signature, expected original SHA-256 from trusted inventory, exact byte-to-pixel handling, alpha/dimension rejection and source-key rotation/revocation. Decoding, camera capture, rotation, resizing and scene truth are trusted assertions, not circuit-proven facts. |
| Verifier failure behavior | Wrong profile/key/source, changed mask/pixel/digest/signature, noncanonical or oversized/malformed inputs, clear fail-closed behavior and no prover-selected trust authority. |
| Service boundary | Queue concurrency/time/memory/output controls, isolated execution, encrypted and access-controlled private enrollment storage, retention/deletion, logs/exports and unauthorized/revoked derivative access. Existing decoder containment evidence does not qualify the ZK worker. |
| Privacy adequacy | Sensitive fields missed by detection/tracking, residual metadata/audio/filenames, human approval, export inventory and a separate independent sensitive-class corpus. A correct transformation proof cannot establish sufficient redaction. |

The source [privacy specification](../../../research/privacy/README.md) documents the
existing adversarial tests and the exact backend enrollment/proving/export boundaries.
No application-specific trusted setup ceremony is performed by the prototype; that
does not remove the need to review the framework, keys and assumptions. Supply findings
with severity, reproducible cases, affected source hashes, proposed remediation and a
retest decision. An independent report is evidence for a later gate, not release authority.

## Needed from the owner

- Nominate or fund a qualified independent cryptographic reviewer for the exact scope
  above. No outreach, payment, audit engagement or certification was performed here.
- Choose the actual intended compute environment, concurrency, latency/memory/cost
  budget and supported profile. The local three-sample result cannot choose an SLA.
- Supply separately governed/consented sensitive-class data and reviewers for privacy
  adequacy; these are distinct from synthetic circuit correctness.
- After review, approve a bounded target-host evaluation and any resulting experimental
  integration. Larger images/video require additional research and a new reviewed method;
  this packet does not imply they are already supported.
