# UI/UX redesign implementation and acceptance record

Governing plan: `PackProof_Astra_UI_UX_Redesign_Development_Plan_2026-09-07(1).docx`. Governing product rule: **The seller supplies intent and records what happens. PackProof handles the mechanics.** Automation must not manufacture certainty.

This record maps the integrated September 8 source candidate. Its exact published commit and CI runs are recorded in the candidate pull request. The release-evidence template deliberately retains null fields for unavailable artifact, device and rollout evidence. A source file, green unit test, debug APK, signed AAB, Play upload, and installed-device result are different facts.

## Working baseline

The implementation base is GitHub `bcedec57d9a56800a1ed80f6e5c4959b6de7dab4`, branch `codex/etsy-automatic-fulfillment-2026-09-07`, followed by working branch `codex/ui-ux-redesign-2026-09-08`. The older scratch candidate `8c18e2f59fc9c6fa0dfc733acc71de47375fd081` has the same complete tree, `675901809f6bb8cb5d42c49cdc5e505da6a55b48`. Main `6bc3ea1200ad4a57c1f17fc468e54db067ca86e4` is an older baseline and must not silently replace the comprehensive/recovery/Etsy work.

At the W0 live inspection, the configured staging API at `https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws` returned `/meta` commit `594ea0e0414228c4d149527b4f138a8095765b02`, version `2026-09-06-recovery`, and image digest `sha256:6159f17f5462a86c47586058fa6d8a63b5dbb4764a5063ba6b0bb0ac8af7f904`. ECS confirmed that image. `/capabilities` returned HTTP 401, although the newer source provides a public capability contract. Live schema, new correction policy, label review, and account-request endpoints were not verified. The candidate source and live API are different generations.

The previous artifact `packproof-0.3.8-37.aab` is 45,507,896 bytes, SHA-256 `898aa80e3b93f8ef97fb291e75091bff71d0474fad38a9fc341d64a58ce74368`. Its packaged config was inspected: version `0.3.8`, versionCode `37`, package `com.packproof.mobile`, backup and cleartext disabled, staging API above. **This is an old artifact, not the redesign AAB.** Its EAS source/build identity and whether either phone installed it remain unverified. The redesign must select a monotonically greater versionCode after checking EAS/Play history and retain the existing signing lineage.

Neither `https://thepackproof.com/release.json` (404) nor the legacy CloudFront `/release.json` (HTML fallback) established the served web source SHA. Final web deployment identity must come from the actual hosting workflow and inspected served artifact.

## Work packages

| Package | Source work found | Required evidence still open |
|---|---|---|
| W0 | Base reconciliation, runtime/artifact identity inspection, integrity and recovery inventory. | Installed baseline identity, live schema/capabilities and served web identity. |
| W1 | Shared action/success tokens, Orders/Proofs/Account navigation, minimal creation, semantic rows/disclosures. | Final integrated route tests, narrow/200% type and both-theme review. |
| W2 | Shared ordinary capture, in-video observation handling, optional original-frame inspection, review, context-bound signing, recovery and authoritative completion. | Final integrated/native compile, two-phone uninterrupted capture/signing/encoded-media verification. |
| W3 | Origin-aware correction policy and append-only source observations; grouped activity, tracking distinctions, same-record disclosure and viewer presentation. | Final direct API/stale-client suites, media playback/position review, authenticated/shared parity on the deployed candidate. |
| W4 | Batch queue reuses capture/completion; consolidated channels, persistent server automation, local-copy management, authenticated deletion-request receipt and public request resource. | Three-order interruption run; real OAuth/provider state; public-host deletion route; operational request handling and reviewed retention disclosure. |
| W5 | Recovery and presentation fixtures, source tests, inherited scoped timing instrumentation. | Remaining integrated failures, native accessibility, real-device resilience, eight fresh-user sessions and measured gates. |
| W6 | Existing source BOM, native CI, signed AAB and deployment workflow recipes identified. | Exact final commit, signed redesign AAB, distribution/install evidence, rollback rehearsal and all blocking human/device gates. |

Use [ACCEPTANCE.md](ACCEPTANCE.md) for T01–T26, [DESIGN_AND_STATE.md](DESIGN_AND_STATE.md) for interface contracts, and [RELEASE.md](RELEASE.md) for build/rollout evidence and the device/usability protocol.

## Validation checkpoint

- Backend, mobile and web TypeScript checks pass; backend and web production builds pass.
- Integrated web: **29 files, 190 tests pass**. Integrated mobile: **87 tests pass**, plus **8 build/security tests pass**. New order/label/channel coverage is included in the persistent `test:redesign` CI gate.
- Initial complete backend suite: **712 pass, 10 fail, 11 skipped** across 110 files. Failures were six superseded presentation expectations and four imported-edit/label-conflict fixtures. After correction, all eight affected/new suites pass: **105 tests**, including immutable imported fields, legacy source attribution, label review, wrong-package observations, capabilities and presentation. The final local complete run had **750 pass, 1 fail, 11 skipped**; its sole remaining legacy manual-creation Back expectation was corrected and explicit origin cases added. Hosted CI supplies the exact-source complete-suite gate separately.
- Browser review: public deletion page and privacy navigation; existing fictional Proof Recording/Activity/Tracking with keyboard navigation; synthetic Orders and compact Account fixtures at 360 CSS-pixel content width in light/dark. Fixed header spacing and title contrast. These fixtures had no network actions and are not authenticated/device acceptance evidence. Temporary harness files were removed.
- W5 now records the 13 finite interaction kinds and optional real build SHA in the existing opt-in study. Schema and clients preserve prior timing phases and consent withdrawal; standalone order/share actions are excluded from capture-effort denominators. See `VALIDATION.md`.
- Existing token-free CI compiles both Android Kotlin modules and builds a debug APK. Candidate compilation exposed a nullable optional barcode bounds value in an Expo event; the corrected payload omits unavailable bounds. A debug APK is not a signed release AAB. Final-source native status is recorded separately in the PR.
- No signed redesign AAB, Play upload, installed-phone test, eight-person study or production deployment is claimed.

## Resume checkpoint

1. Read the final candidate PR/CI and `VALIDATION.md`; resolve any native or full-suite release gate on that exact source.
2. Restore authorized Expo automation access and verify EAS/Play versionCode history. The configured candidate is **0.3.9 / 38**; 38 is greater than the inspected old bundle but remote history is not yet verified. Reuse the existing package and remote signing lineage.
3. Establish a compatible candidate API/schema/web environment. Existing live API source differs from this candidate; the new client rejects starting an ordinary recording until required capabilities are available.
4. Generate and validate the signed AAB from the gated source, record its checksum/size/build ID, distribute internally and install through the intended test route on both phones.
5. Execute all physical/upgrade/accessibility and eight-user gates before wider rollout. Preserve existing originals and journals during rollback; Android recovery uses a higher verified versionCode.
