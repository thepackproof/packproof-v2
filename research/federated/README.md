# ProofCollective / F10

This is an **isolated, executable synthetic research system**. It trains a four-weight
logistic frame-usefulness model using real Flower 1.39.0 SecAgg+ and central Gaussian
noise. It does not train on customer evidence or connect to production. Real partner
pilots and distributed-noise privacy remain blocked by the requirements below.

## Run

Python 3.12, CPU only. From the repository root:

```sh
python3.12 -m venv research/federated/.venv
research/federated/.venv/bin/pip install -r research/federated/requirements.lock
PYTHONPATH=research/federated research/federated/.venv/bin/python -m proofcollective.cli simulate --output /tmp/proofcollective-lab
PYTHONPATH=research/federated research/federated/.venv/bin/python -m pytest research/federated/tests -q
```

Keep the output directory/ledger across campaigns: changing `--campaign` cannot reset
cumulative participant exposure. CLI bounds are 20–64 synthetic clients and 1–3 rounds.
A failed round keeps its reserved budget. Nothing refunds privacy spend or exports
individual model updates. `--privacy-mode distributed` fails closed with the missing
reviewed assumptions. There is no production/pilot command or deployment automation.

Verify the checked-in measured candidate without a PackProof account:

```sh
PYTHONPATH=research/federated research/federated/.venv/bin/python -m proofcollective.cli verify --artifact research/federated/reports/2026-10-02/models/92b72f362c6e909ae403fc2d3720847a1c395c5c52f122d1fe8955a4fdd2f3e3.json --trust-key research/federated/reports/2026-10-02/trust-key.hex
```

Use the exact `candidateArtifact` path recorded in `report.json` if verifying another
run. Research signing keys are ephemeral; only public keys are exported. Recipes,
input models and candidates have domain-separated Ed25519 signatures. They use this
package's explicitly versioned ASCII JSON encoding, **not the core evidence signature
format**. No signing material comes from production.

## What executes

`model.py` trains only technical measurements (sharpness, glare fraction, local
contrast, bias), with a bounded dataset, at most 64 optimization steps and norm-1
partner updates. Dataset generation and frozen holdout seeds are separate. A local
NPZ loader checks exact SHA-256 consent/purpose, compressed and expanded byte limits,
array headers and the `quality-v1` preprocessing contract before training. It accepts
no images, transaction IDs, reputation or fraud targets.

`protocol.py` calls the maintained, pinned **unmodified** Flower
`SecAggPlusWorkflow` and `secaggplus_mod`. All four stages execute: key setup, encrypted
secret sharing, masked-vector collection and threshold unmasking. There is no
homegrown masking or secure-summation implementation. Equal partner weights are
fixed at one, and client sample counts and fit metrics are not sent. Assertions reject
clear individual model arrays in masked replies. Poisoned aggregate norm/non-finite
checks protect release; they do not prove each malicious client's clipping.

The default simulator serializes real Flower protobuf messages through per-client
Fernet authenticated encryption. `--transport local-mtls` instead executes those same
messages over actual TLS 1.3 loopback sockets using Python ssl/OpenSSL, mutual CA and
certificate verification, pinned certificate/node IDs and bounded replay-protected
framing. Real socket tests cover encrypted-record corruption, wrong credentials,
party/session binding and dropout. See [TRANSPORT.md](TRANSPORT.md) for its operational
profile, exact protocol and measured evidence. Both modes belong to one local process
and operator; neither establishes independent partner control or isolation from that
operator's memory. A pilot still requires separate partner-controlled machines,
reviewed identity/key management and deployment-specific attack qualification.

`governance.py` stores append-only consent/withdrawal and budget events in SQLite,
serializes reservations with `BEGIN IMMEDIATE`, and composes Google's pinned
`dp-accounting` Gaussian events for each stable partner identity across all campaign
names. Withdrawal stops future protocol work and aborts an unreleased round; it does
not erase earlier model influence. A database administrator can erase a lab database;
a pilot requires governed stable enrollment and protected, backed-up ledger storage.

## Privacy scope and gates

- Protected unit: replacement of one enrolled partner's bounded contribution, fixed
  equal weighting. No subsampling amplification is claimed.
- Each aggregate requires at least **20 contributors before unmasking**. All-to-all
  shares use reconstruction threshold 20, including the exact 20-client case.
- Sensitivity is `2 * (clipNorm + quantizationL2Slack) / actualContributors`; slack
  includes the Flower stochastic quantization error. Noise multiplier is 4.
- Every participant is charged before training/aggregation, including later dropouts.
  Cumulative epsilon must stay at or below 3; delta is at most
  `min(1e-6, 1/(10*N*N))` and never relaxes an already stricter ledger value.
- **The coordinator sees the pre-noise aggregate.** Central noise protects released
  model outputs under the trusted-coordinator model; it does not hide that aggregate
  from the coordinator. Secure aggregation alone is not DP.
- The noise uses OS-entropy-backed `SystemRandom` Gaussian floating-point generation.
  Adjacency, quantization, finite precision, noise, accounting and multi-round
  assumptions need independent privacy review before any real-world DP claim.
- Stronger distributed-noise release is blocked: there are zero independent
  contributors, no reviewed honest-noise/collusion/dropout guarantee, and no claimed
  server privacy. No silent substitution of central noise occurs.

`ModelRegistry` stores signed candidates separately from release. A local-research
promotion requires ≥5 percentage-point heldout improvement over the frozen baseline,
no >2-point loss in any predefined group, valid signature and privacy budget. It has
an append-only release/rollback history; rollback can select only previously approved
signed artifacts. Production authorization remains false. Existing finding model
versions are not rewritten.

## Measured evidence / October 2, 2026

`reports/2026-10-02/` contains the actual report, signed recipes/input models/candidate,
public trust key, synthetic consent/privacy ledger export, focused JUnit result and
artifact digests. One run used **24 synthetic clients, two rounds and 3,072 heldout
synthetic vectors** in 7.78 seconds on this workspace CPU environment.

| Comparison | Heldout synthetic accuracy |
|---|---:|
| Frozen current heuristic baseline | 84.96% |
| Single local synthetic client | 94.47% |
| Federated without DP, synthetic-only ablation | 96.03% |
| Federated with actual central noise | 91.54% |

The noisy candidate improved over the frozen baseline by 6.58 points; all three
synthetic group gains were positive. It **did not outperform the local-only model**
in this run. These numbers do not establish camera accuracy, useful cross-partner
improvement, attack resistance or a privacy certification. Fresh DP noise is not seeded
for repeatable metrics; exact measured artifacts are preserved. No favorable-run
selection or repeated tuning against this holdout was performed.

The focused suite covers consent/purpose/dataset mismatch, withdrawal during protocol,
signed-recipe/model tampering, bounds, real aggregation with dropout, threshold abort,
encrypted-share tampering, authenticated-envelope replay/wrong-partner rejection,
poisoned aggregate rejection, cumulative budget/reset attempts, signed release failure
and rollback, exact 20-contributor operation, and bounded local preprocessing.

## Remaining qualification dependencies

F10-01 through F10-04 and F10-06 have engineered local implementations and synthetic
protocol test evidence. F10-05 stronger privacy is **BLOCKED**. Before a real pilot:
obtain independent privacy/security review; a validated task and representative
consented partner-local data; ≥20 independently enrolled contributors; a protected
consent/accounting authority; independent TLS/enrollment deployment attack qualification; cross-partner
and supported-device holdout; enrollment/poisoning evaluation; key/backup recovery
review; retention and withdrawal operations; and explicit separate pilot authorization.
None of those are satisfied by the synthetic run. Customer rollout is not authorized.

## Primary references and dependency record

- [Flower secure aggregation example](https://flower.ai/docs/examples/flower-secure-aggregation.html): production examples must disable revealing demo logging.
- [Flower secure aggregation protocol](https://flower.ai/docs/framework/explanation-ref-secure-aggregation-protocols.html): implementation and semi-honest protocol boundary.
- [Flower TLS](https://flower.ai/docs/framework/how-to-enable-tls-connections.html) and [SuperNode authentication](https://flower.ai/docs/framework/how-to-authenticate-supernodes.html): reference deployment guidance.
- [Python ssl/OpenSSL](https://docs.python.org/3.12/library/ssl.html): maintained TLS adapter implementation.
- [Google DP accounting overview](https://github.com/google/differential-privacy/blob/main/python/dp_accounting/docs/overview.md): mechanism composition and accountant use.

`requirements.lock` pins the exact executed dependency set;
`dependency-inventory.json` records versions and package-declared licenses. Flower and
Google DP accounting are Apache-2.0, NumPy is BSD-3-Clause, cryptography is Apache-2.0 OR
BSD-3-Clause. Transitive/security review remains a pilot gate. Sources were consulted
October 2, 2026; documentation claims do not certify this integration.

## Backend registry integration

Migration `080_rnd_learning.sql` provides a separate immutable training-report registry.
Only a system administrator can import/list/export a report through
`/admin/rnd/learning-reports`. The service verifies the Python artifact's exact signed
bytes, Ed25519 signature, separately pinned key, model digest, purpose, synthetic scope,
privacy profile and bounded evaluation schema. An import adds an immutable administrator
audit event. Imports are idempotent by payload digest. No import starts training,
changes model policy, reads customer evidence or authorizes release.

Configure `PACKPROOF_RND_LEARNING_TRUST_KEYS` with explicitly approved **research**
public keys (64 lowercase hex characters, comma separated), along with the global
research environment and ProofCollective processing/internal-display flags. With no
pinned key, imports fail. Do not reuse the supplied lab key as a production authority.
The server accepts only the existing `SYNTHETIC_LOCAL_RESEARCH` artifact profile;
partner-pilot artifacts require a separately reviewed implementation change.

A per-Proof research-status extension additionally requires current system-admin
role, participant access, separate `LEARNING` consent and an exact immutable
`learningReportId`. Its source references are context only: source bytes are not read,
used for training or evaluated by that operation. The registry export includes the
original signed candidate and safe summary; partner identities, local examples,
labels and per-partner privacy-spend records cannot enter this API schema. Backend
integration tests verify the real Python-generated signature, API authorization,
trust/purpose/scope/budget failures, append-only persistence/audit and safe export.
