# Connect desktop UX and connection recovery candidate

Date: November 16, 2026. Source baseline: PR #163 head `08745308c8621ecbc59fb820da15e40123c4cda9`, built on `main` commit `a9568101df67722a6b03f44154e99c5598f60021`. This record accompanies the November 14 **Product-quality onboarding redesign and connection-recovery specification**. It separates code and automated checks from installed-product and release acceptance.

## Build identity and reproducibility

The supplied screenshot identifies `0.2.0 development`; the reviewed PR #163 sources identify app/service `0.1.2`. The screenshot's exact binary, source commit, renderer bytes, protected state and authenticated API observations are unavailable. Its build lineage and precise runtime root cause remain unproven. A fresh source checkout is not evidence that the installed screenshot build was reproduced. The new app/service/bridge candidate is version `0.2.1`, a distinct release above both reported versions. This does not establish the lineage of the screenshot build.

Every new build writes `dist/main/build-provenance.json`, packaged alongside the runtime configuration. It records full source commit, whether the worktree contained uncommitted source, application and service versions, bridge protocol, CSV rules/profile versions, channel, and the SHA-256 and size of every built main/renderer asset. It includes no report contents, credentials or original source paths. It does not attest to the deployed backend build.

Native artifact qualification independently reads `resources/app.asar`, verifies its app version, and recomputes its asset inventory against that manifest and the candidate output. Modified, missing, added or stale renderer/main files, a different source commit/channel, or dirty source for a signed channel stop qualification. The manifest and its version matrix are included in `release-evidence.json` and uploaded with the installer. Native service/bridge executable hashes and signatures remain covered by the existing executable inventory. Development outputs retain their explicit unsigned/internal-only classification.

The current source versions are a pairing identifier only; current authenticated API capabilities must also advertise `packproof.scheduled-csv/v2` and the exact locally bound rules version. A package version, a successful login or an online Windows service alone never establishes compatibility or active collection.

## Implementation and acceptance map

| Work | Code/evidence boundary | Completion evidence required |
| --- | --- | --- |
| W0 build evidence | Source-bound build manifest; service/transport diagnostics | Installed screenshot build lineage remains unknown; use new manifest plus actual installed diagnostics for the new candidate |
| W1 compatibility/browser | Authenticated, expiring capability observations; existing strict service/API v2 guards and exact review locator | Matching hosted backend/browser, old/mismatched backend rejection before original upload, login return to exact review |
| W2 state ownership | Pure desktop view model, transport observation, authoritative approval and verification states | Focused state tests for stale errors, missing/expired capabilities, network failure, revoked permission and active acknowledgement |
| W3–W4 desktop/review | Desktop shell, semantic tokens, shipment preview, focused correction and Advanced drawer | Screenshots and keyboard/responsive checks at supported sizes; mapping reanalysis and review invalidation |
| W5 activation | Existing protected configuration → original → exact batch → canonical Proof → recurring approval orchestration | Separate browser approvals, restart-safe progress and no false connected state |
| W6 source home | Independent service, export, import, queue and permission observations | Active/paused/offline/revoked behavior; source freshness must remain unknown without source evidence |
| W7 Windows E2E | Existing native candidate workflow and protected-storage smoke tests | Actual Windows 11 clean install/upgrade with pending work; full hosted first import plus unattended second export |
| W8 accessibility/usability | Focus management, Advanced dialog, semantic controls, high contrast/reduced motion | Installed keyboard/screen-reader/scaling acceptance plus five users, at least four unaided completions |
| W9 release/rollback | Source-bound artifacts, signed release workflow, protected queue policy | Matching backend/browser first; signed internal cohort; recorded rollback rehearsal and customer acceptance |

## Recorded checks for this refresh

| Check | Observed result |
| --- | --- |
| Release policy and provenance regression suite | Seven passing Node tests. The added test packages a real fixture ASAR, detects a stale/changed packaged renderer, rejects wrong source identity and unexpected assets, and rejects dirty signed-release source |
| Desktop typecheck/component/view-model tests and build | 71 Vitest tests passed; TypeScript check and development renderer/main build passed |
| Browser/backend focused tests and builds | 47 browser approval tests and 25 backend agent tests passed; backend TypeScript and web production builds passed |
| Cross-platform service suite | 115 passed; five native Windows-only tests skipped on Linux with .NET 10.0.404. This is not native acceptance |
| Native Windows candidate | PR-triggered `Connect Windows candidate` builds on `windows-2025`, then runs service tests, packaging, LocalService/bridge/permissions and storage-repair smoke checks. A new exact-source run is required; its result must be recorded before distributing the candidate |
| Windows 11 installed-product and five-person acceptance | Not performed in this workspace; remains open |
| Signed bundle, staged rollout and live deployment receipts | Not performed by this documentation/provenance change; remains open |

Browser screenshot QA could not be completed because the available browser could not reach the local preview; DOM keyboard/focus tests and source inspection do not establish visual/scaling acceptance.

The native candidate workflow runs automatically when a PR changes `connect-windows/**` or its rules/fixtures/workflow. It publishes a development installer only if all candidate validation and both native smoke scripts succeed. Its GitHub Actions run and final source SHA must be retained with the artifact hashes. A Windows Server runner pass does not establish Windows 11 installed-product acceptance.

## Safe rollout sequence

1. Complete source-bound CI and additive backend validation/capability qualification. Deploy matching backend support first using the existing exact-source workflow and inspected immutable image/task/topology inputs. Keep v1 sources supported under their existing semantics; old clients cannot consume v2 by fallback.
2. Deploy the matching browser review and verify exact installation/import return through authentication, workspace checks, stale/expired/denied reviews and separate configuration/batch/recurring decisions.
3. Install the matching internal Windows candidate. Record its source/asset manifest, actual service/bridge/rules versions, authenticated transport probe and backend `/meta` identity. Run the full first Proof and second unattended eligible export. Closing the UI must not stop the authorized background service.
4. Exercise network loss/reconnect, restart/reboot, expired/revoked grant, changed source, protected queue continuity, upgrade and rollback. Complete installed accessibility and five-user acceptance. Produce/verify the signed release candidate, then stage a measured cohort rollout.

Do not treat unit tests, a successful installer build or an improved screenshot as approval to close the installed-product gates. No action in this record authorizes deleting protected work or granting permissions on the user's behalf.

## Rollback and preserved work

Pause affected sources through existing controls. Preserve encrypted originals, queue, source binding, keys, receipts, canonical records and audit history; retain the semantic server rejection introduced by PR #163. A server-accepted import may finish after local collection is paused. Prefer a compatible corrective release that resumes the same protected state and idempotency keys.

Do not reset ProgramData, remove SQLite/spool files, widen service ACLs, silently migrate ownership, reinterpret an old original under new mappings or grant recurring collection merely because connectivity returned. Reinstall/repair must retain protected work. A prior binary is usable only with a compatible contract and current required approval. This refresh adds no database migration to reverse. Record actual queue/receipt continuity and the eventual source state during the rollback rehearsal before declaring rollback qualified.
