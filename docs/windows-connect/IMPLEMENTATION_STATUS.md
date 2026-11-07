# Windows Connect implementation status

Date: 2026-11-07. Source implementation, verification, deployment and customer acceptance are separate states.

## Baseline and source

Repository: `thepackproof/packproof-v2`. Branch: `feature/packproof-connect-windows`. Starting main commit: `a42c10653258b63217043f8670b94ca87a233684`. Implementation PR: https://github.com/thepackproof/packproof-v2/pull/147. RFC PR 146 remains unchanged.

Reused Electron/NSIS patterns, organization principals and encrypted command replay, partner CSV preview/commit/status, canonical source bindings and the existing records portal. No existing unattended service was present. The new .NET worker is a bounded client; the API remains hosted. PR 147 is merged into main at `531c13025f7ed87fdd6557f6a64377dc32985d61`; all checks on its final head passed. The Windows Connect API and portal changes are not deployed.

## Work packages

| Package | Source and observed verification | Remaining acceptance |
| --- | --- | --- |
| W01 baseline/native build | Implemented; exact-source installer and executable inventory verified | Internal artifact only |
| W02 service/bridge | Implemented; actual LocalService, protected storage, expected-service peer, source read and restart passed | Windows 11 logoff/reboot; additional real-token and counterfeit-peer CI checks prepared |
| W03 enrollment/restrictions | Implemented; focused policy and full backend tests passed; contract checked | Deployed administrator enrollment |
| W04 queue/spool | Implemented; encrypted persistence, stable operations, recovery, quotas and original cleanup tested | Real Windows full-disk/interruption exercises |
| W05 CSV vertical slice | Implemented; server/worker, original digest, replay and duplicate contracts tested | Real Windows service to approved hosted sandbox record |
| W06 guided setup | Implemented; 12 UI/security cases; welcome layout inspected | Full native journey, screen reader and 200% review |
| W07 health/support | Implemented; separate health facts, real receipt-backed imports, pause/revoke and diagnostic preview | Deployed operational observation |
| W08 credentials/replacement | Implemented; drain, renewal and protected recovery tests passed; prior receipt ownership preserved | Real renewal and interruption acceptance |
| W09 install/update/repair/remove | Implemented; installer built; native repair preserves approved operator and removal retains protected work | Signed Windows 11 NSIS/UAC, upgrade/rollback and coexistence |
| W10 regression/hardening | Backend 1,763 passed / 17 existing opt-in skips; web 436 passed; native Windows 36 passed | Signed candidate security, accessibility and resource acceptance |
| W11 source/novice acceptance | Engineering preparation complete | Named source, authorized dataset, at least five observed first-time users and pilot observation |
| W12 publish/canary | Release controls and runbook prepared | G1–G3, signed release channel and fresh production canary |

## Gates

- **G0:** Passed for the internal foundation on hosted Windows Server 2025: exact package, inventory and 13 real LocalService checks. This does not establish Windows 11 or NSIS/UAC qualification.
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

## Release preparation continuation

A separate additive migration-108 operator now prepares an explicitly reviewed nonproduction target without altering the frozen095→107 operators. It requires preserved historical data/catalog/ACLs, an independently qualified previous-image rehearsal on a distinct restored endpoint, actual ECS/image binding and runtime-login checks. The current107 rollback image needs a checksum-pinned108 compatibility bridge before that rehearsal can qualify. The operator does not provision roles, activate organizations or deploy a service. Ten targeted migration tests and inventory checks passed locally; hosted PostgreSQL and current-head CI remain required for subsequent source changes. Full readiness CI passed at8713435; dedicated real PostgreSQL108 coverage is added in the image-preparation follow-up.

The native smoke now includes disposable standard-user ACL probes, same-identity NETWORK-token denial, counterfeit pipe-peer refusal before any request bytes, and an actual bounded idle resource observation. All 13 foundation checks passed in hosted run42346847313 at merge87836af1eb2ca289cbabe1f388da358db6f155ec, including the new negative access cases. They do not establish a remote-machine transport test or Windows11 acceptance.

Read-only AWS inspection confirmed the public API still runs source `e346452ade2744820fb2f429d7aeb94fef376419` and immutable image `sha256:d1775ac9ff380b7364814ed1ad7504c8eef6e82484f686d9e381dcf16c816ff0`. Its resource name contains staging but its environment is production. The separate `packproof-m1-20261020` database is tagged isolated-m1-test and synthetic-only; its ledger and current-schema eligibility remain to be inspected. Its private runtime has no NAT/default route or VPC endpoints, preventing image/secret/log bootstrap. No cloud data, roles, secrets, service configuration or feature activation has been changed.

PR148 merged at `bfd781f08c939a5ca4bfbfc4cbf69ee02a6cabcd` after all checks passed. Its backend full suite passed1,763 cases with17 existing skips and zero failures. The latest internal installer is167,269,137 bytes, SHA256 `93c45e3bf0c14263fb8f35b66299b57c5f62d466fb213d6decdd60b4c72b3377`: https://github.com/thepackproof/packproof-v2/actions/runs/42346847313/artifacts/13564460154. It remains unsigned and internal. The observed service-idle interval was6.005 seconds,53,620,736 bytes working set and0.846% normalized CPU on the hosted four-processor server; this is one observation, not reference-PC performance acceptance.

Image preparation now uses a narrow connect-v1 Git-blob archive that supplies both new runtime probes. Candidate and immutable-base rollback build requests reuse the existing CodeBuild project without project mutation, migration or deployment. The rollback guard source is `7e4cf9ed7635a0104d6a8a1b2ba93334c8e61184`, based on the actual production source, and accepts only the exact108 checksum. Neither image build nor restored-database qualification has run. Signing remains blocked by GitHub browser authentication; the secure sign-in request was cancelled. A later AWS metadata refresh was also cancelled; no build, migration or service update was attempted.
