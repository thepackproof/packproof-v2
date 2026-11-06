# Windows Connect implementation status

Date: 2026-11-06. This file separates source implementation, test verification, deployment and customer acceptance.

## Baseline

- Repository: `thepackproof/packproof-v2`; implementation branch: `feature/packproof-connect-windows`.
- Starting commit: `a42c10653258b63217043f8670b94ca87a233684` (`main`). RFC PR 146 remains a separate draft.
- Reused: Electron/NSIS patterns in `desktop/`; organization principals and encrypted command replay; partner CSV preview/commit/status; canonical source bindings; existing records portal.
- No existing unattended Windows service was present in this checkout. The worker is a bounded .NET 10 addition; the API stays hosted.
- Target for the first actual integration: an approved nonproduction organization. No customer or production organization has been selected or activated by this work.

## Work packages

| Package | Source | Verified evidence | Deployment / acceptance |
| --- | --- | --- | --- |
| W01 baseline/native build | Implemented | Exact baseline and native workflow; candidate runs recorded below | Internal candidate only |
| W02 service/bridge | Implemented | Service/bridge compile without warnings; native service smoke prepared | Windows permissions/logoff/reboot acceptance pending |
| W03 enrollment/restrictions | Implemented | 20 focused agent cases; affected backend regression; mounted contract check | Not deployed |
| W04 queue/spool | Implemented | Protected queue, stable operation identity, interruption and quota cases in native suite | Windows full-disk/interruption acceptance pending |
| W05 CSV vertical slice | Implemented | Original digest, transport, import, worker and duplicate checks with synthetic fixtures | Real Windows to nonproduction API G1 pending |
| W06 guided setup | Implemented | 12 Connect UI/security cases; visual welcome inspection; stale approval/consent cases | Native screen-reader/200% acceptance pending |
| W07 health/support | Implemented | Four health facts, server-derived imports, pause/revoke and redacted diagnostic preview | Not deployed |
| W08 credential lifecycle | Implemented | Drain/renewal and protected replacement recovery; former queues never reowned | Native interruption / real renewal acceptance pending |
| W09 packaging/lifecycle | Implemented | Separate identities, publisher guards, NSIS hooks, repair/data-preserving removal; CI pending | Exact signed Win11 package lifecycle pending |
| W10 regression/hardening | Partially verified | 134 affected backend tests, 436 full web tests, builds/typechecks, contract check; native suite details in EVIDENCE.json | Exact final hosted/native release checks pending |
| W11 source/novice acceptance | Prerequisites pending | No customer export or user observations fabricated | Not accepted |
| W12 publish/canary | Downstream gates pending | No public artifact or fresh-download production canary | Not published |

## Completion gates

- **G0:** Pending exact-source internal package and native foundation evidence. A hosted Windows Server service smoke is not Windows 11 support qualification.
- **G1:** Blocked on an approved nonproduction organization and real Windows service-to-record run. Fake transport tests do not pass this gate.
- **G2:** Pending signed candidate, full Windows lifecycle/security/accessibility/resource evidence and required final CI.
- **G3:** Blocked on a named source/exporter/version, source owner, reconciled customer-approved dataset, at least five observed first-time users and pilot observation.
- **G4:** Blocked on G1–G3 and fresh download/install/import production canary.

## Source publication and validation

PR: https://github.com/thepackproof/packproof-v2/pull/147. Direct Git push was unavailable; connected GitHub publication produced byte-identical trees verified against local Git. The code is not merged or deployed. RFC PR 146 is unchanged.

Initial Windows run 42274254134 passed UI/typecheck/release-policy checks, then exposed a Windows live SQLite inspection sharing error (25 native tests passed; one failed). The privacy assertion was preserved and its file-sharing mode corrected. Initial schema inventory failures in PostgreSQL/worker CI were fixed by including the additive immutable import-binding columns in the new source-bound privilege inventory; frozen historical manifests were not rewritten.

Local full Vitest collection initially stalled without reporting a file. Bounded, serial thread-pool execution passed all 436 web tests and an explicit 134-test affected backend selection. The full backend result must come from required hosted CI; local collection timeout is not a passing result. Current exact outcomes, commits and artifact hashes belong in EVIDENCE.json. Remaining prerequisites and owner actions belong in BLOCKERS.md.
