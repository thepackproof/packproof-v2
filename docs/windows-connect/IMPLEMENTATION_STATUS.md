# Windows Connect implementation status

Date: 2026-11-06. Source implementation, verification, deployment and customer acceptance are separate states.

## Baseline and source

Repository: `thepackproof/packproof-v2`. Branch: `feature/packproof-connect-windows`. Starting main commit: `a42c10653258b63217043f8670b94ca87a233684`. Implementation PR: https://github.com/thepackproof/packproof-v2/pull/147. RFC PR 146 remains unchanged.

Reused Electron/NSIS patterns, organization principals and encrypted command replay, partner CSV preview/commit/status, canonical source bindings and the existing records portal. No existing unattended service was present. The new .NET worker is a bounded client; the API remains hosted. The source is not merged or deployed.

## Work packages

| Package | Source and observed verification | Remaining acceptance |
| --- | --- | --- |
| W01 baseline/native build | Implemented; exact-source installer and executable inventory verified | Internal artifact only |
| W02 service/bridge | Implemented; actual LocalService, protected storage, expected-service peer, source read and restart passed | Windows 11 logoff/reboot and adversarial pipe tests |
| W03 enrollment/restrictions | Implemented; focused policy and full backend tests passed; contract checked | Deployed administrator enrollment |
| W04 queue/spool | Implemented; encrypted persistence, stable operations, recovery, quotas and original cleanup tested | Real Windows full-disk/interruption exercises |
| W05 CSV vertical slice | Implemented; server/worker, original digest, replay and duplicate contracts tested | Real Windows service to approved hosted sandbox record |
| W06 guided setup | Implemented; 12 UI/security cases; welcome layout inspected | Full native journey, screen reader and 200% review |
| W07 health/support | Implemented; separate health facts, real receipt-backed imports, pause/revoke and diagnostic preview | Deployed operational observation |
| W08 credentials/replacement | Implemented; drain, renewal and protected recovery tests passed; prior receipt ownership preserved | Real renewal and interruption acceptance |
| W09 install/update/repair/remove | Implemented; installer built; native repair preserves approved operator and removal retains protected work | Signed Windows 11 NSIS/UAC, upgrade/rollback and coexistence |
| W10 regression/hardening | Backend 1,753 passed / 17 existing opt-in skips; web 436 passed; native Windows 36 passed | Signed candidate security, accessibility and resource acceptance |
| W11 source/novice acceptance | Engineering preparation complete | Named source, authorized dataset, at least five observed first-time users and pilot observation |
| W12 publish/canary | Release controls and runbook prepared | G1–G3, signed release channel and fresh production canary |

## Gates

- **G0:** Passed for the internal foundation on hosted Windows Server 2025: exact package, inventory and eight real LocalService checks. This does not establish Windows 11 or NSIS/UAC qualification.
- **G1:** Blocked on an approved hosted nonproduction organization and real Windows service-to-record run. Mock transport and assembled-server fixtures do not pass this gate.
- **G2:** Blocked on a signed candidate and Windows 11 lifecycle, adversarial security, accessibility, resource and release acceptance.
- **G3:** Blocked on a named exporter/version and source owner, customer-approved reconciliation, five first-time-user observations and pilot observation.
- **G4:** Blocked on G1–G3 and a fresh download/install/import production canary.

## Verified internal candidate

Code head: `328b529b85f0c4559f00355776acfa32b897e68d`. Actual native build/merge: `785726612dca6a7dda16e2eac5146347aaf6d9b7`.

Installer: `PackProof-Connect-development-Setup-0.1.0.exe`, 167,275,656 bytes. SHA-256: `30c66bafddacc125d9a1b52a2ffc7321da87742c51e9bf1d8bdadb33526ab8a3`. This is unsigned and internal; public distribution is not enabled.

Artifact and receipts: https://github.com/thepackproof/packproof-v2/actions/runs/42278979178/artifacts/13534087775 (expires December 6, 2026).

The Windows candidate passed 36 native cases, 12 UI/security cases, three release-policy cases and eight actual service-foundation cases. Those foundation cases cover LocalService identity, DPAPI, verified peer, immutable local preview, restart, repair retaining the approved operator, and removal retaining data and keys. They explicitly exclude full Windows 11, NSIS/UAC, reboot, remote pipe-client and customer acceptance.

Full backend CI passed 1,753 cases with 17 existing opt-in skips and no failures at head `f8dd1807561b9b2546318630a67935948f7c9cfb`, through merge `2e221b9d0cb92a96d79363f970fe70104f015ab4`. Its backend subtree is byte-identical to the candidate above. Dedicated PostgreSQL release checks passed 21 cases; partner foundation passed 167 cases plus two receiver cases. Full web passed 436 cases plus 12 Node link checks. Contract/SDK, native media, CodeQL and integrity gates passed in the named runs in EVIDENCE.json. Ordinary CI may run again for documentation receipts; only the named completed runs are claimed.

Initial native and packaging failures were corrected without removing assertions or rewriting historical migrations: Windows live SQLite sharing, additive schema inventory, migration file count, local-group description and registry ACL application. Source publication used connected GitHub APIs because direct shell Git authentication was unavailable; published trees matched local Git exactly.

No production migration, API/portal deployment, signed release, named exporter qualification, user study or customer/live canary is claimed. Engineering target: Windows 11 x64, Scheduled CSV Export Folder v1, one local NTFS folder and one direct merchant source. Exact evidence is in EVIDENCE.json; owner prerequisites are in BLOCKERS.md.
