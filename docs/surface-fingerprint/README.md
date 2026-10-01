# Stochastic surface fingerprinting — experimental R&D

This branch implements the October 1, 2026 development plan as an isolated research candidate. It is not an accuracy certification or production rollout. **No camera, device pair, printing process, material or age range is qualified yet.** Store submission, production deployment and customer-visible physical findings are outside this build's authorization.

The existing transaction, continuous recording, committed originals and frozen Proof remain authoritative. Surface evidence adds scoped observations; it cannot establish that contents, closure or custody remained unchanged. Failure to collect or compare is an ordinary unavailable state, never a physical discrepancy.

| Read | Purpose |
| --- | --- |
| [RND_BUILD_REPORT.md](RND_BUILD_REPORT.md) | Actual build artifacts, software checks, local setup and remaining gates |
| [CLAIMS_AND_THREATS.md](CLAIMS_AND_THREATS.md) | What each scope may say; threat controls and unresolved physical tests |
| [SUPPORT_AND_GATES.md](SUPPORT_AND_GATES.md) | Empty qualification registry, exact acceptance gates and progression |
| [PHYSICAL_PROTOCOL.md](PHYSICAL_PROTOCOL.md) | Real corpus collection, blinding, leakage prevention and attack protocol |
| [COST_AND_OPERATIONS.md](COST_AND_OPERATIONS.md) | Measurement fields, unit-cost calculation, kill switch and rollback |
| [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) | FP-01–16 evidence map and explicit remaining work |
| [EXPORT_VERIFICATION.md](EXPORT_VERIFICATION.md) | Offline integrity checks and what they cannot prove |

Blank data-collection templates are in `templates/`. They contain no invented observations. Synthetic fixtures in automated tests establish protocol or numerical behavior only; they are never a physical evaluation corpus.

## Research boundary

Only independently authorized participants may request one-to-one comparisons within a Proof and package/leg. There is no cross-merchant image search, similarity score API for the public, camera-sensor certification, generative detail enhancement or mandatory label purchase.

The target configuration is flat paper labels on corrugated cartons. Ordinary thermal labels are included as a separate print process: direct thermal does not use ink. Print residuals, paper texture, carton texture and label/carton relationship are separate experimental channels. Barcode content selects the expected transaction and does not count toward physical identity.

Before any pilot, an independent validation owner must review actual ordinary-workflow imagery, failure cases, per-profile results and the support registry. A working compile, deterministic fixture or visually convincing comparison does not open that gate.

## Local setup

Run `npm ci` separately in `backend/`, `mobile/` and `web/`. Create a Python virtual environment and install the pinned `surface-worker/requirements.lock` as described in the worker README. From the repository root, `node scripts/rnd/dev.mjs` starts the isolated localhost sandbox with research collection/analysis off. Use `node scripts/rnd/dev.mjs --enable-research --python /absolute/path/to/venv/bin/python` for local experimental collection and internal comparisons. The launcher deliberately supplies local storage, isolated development accounts and unsigned research manifests; these settings do not constitute production identity/signing assurance.

Use the actual lockfile name in `surface-worker/` if its dependency layout changes. The worker is optional: ordinary feature-off capture must keep working when Python is absent or analysis fails. Packaging and native toolchain outcomes are recorded separately; do not submit experimental builds to distribution platforms.
