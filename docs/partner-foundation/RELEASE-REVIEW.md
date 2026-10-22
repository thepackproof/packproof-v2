# M1 review handoff

Recommendation: **HOLD pending remaining evidence**. This is the implementer's evidence packet. The plan requires a recorded M1-06 technical release review and applicable device acceptance; it does not mandate a separate human approver. Earlier references to mandatory independent human approval overstated the plan. Label the reviewer and review scope accurately, close integrity/isolation/recording-loss findings, and bind the decision to source and evidence digests. Independent implementation work may continue while a specific external activation remains blocked.

## Evidence to inspect

| Boundary | Evidence | What it establishes |
| --- | --- | --- |
| Additive migration and historical compatibility | `isolated-migration-evidence-2026-10-20.json` | 86 historical migrations, five additive migrations, two signed synthetic fixtures and 14 unchanged frozen entries; seven real PostgreSQL checks |
| Private storage and database | `isolated-deployment-evidence-2026-10-20.json` | Exact new resources, TLS, encryption, private database, two independently locked buckets and signing keys |
| Application-role preservation and recovery | `isolated-recovery-evidence-2026-10-20.json`, `infra/partner-foundation/RECOVERY-DRILL.md` | Actual scoped role denials, retained exact object versions, externally fenced existing sessions and fresh-target reconstruction; see result and limits in the record |
| Required MFA | `isolated-identity-evidence-2026-10-20.json`, `infra/partner-foundation/IDENTITY.md` | Nine provider checks; the runtime continuation separately verifies six MFA-authenticated users over HTTPS, followed by removal and an empty pool |
| Separate deployed workloads | `isolated-runtime-evidence-2026-10-21.json`, `infra/partner-foundation/RUNTIME.md` | Private API/worker Fargate tasks, distinct ECS-only roles and database logins, cached-credential fence denials, 16 HTTPS checks, two independently verified packages, 20 core/255 policy durable receipts and exact-version retention reads |
| Application correctness | `ACCEPTANCE.md`, PR #108 | Full backend tests at the stated application commit; focused PostgreSQL, contract and transport checks at later runner commits |

Private archives contain synthetic source packages, signed heads and trust material. Their exact S3 object versions and SHA-256 hashes are recorded in the evidence files. Grant a reviewer read-only access through the account's existing access process; do not make the buckets public or send bearer credentials. Review source and evidence at a pinned PR commit.

## Remaining release work

1. Perform a distinct technical review of trust establishment, role separation, retained-version selection, policy completeness and old-writer fencing. The earlier recovery drill uses separate SDK credentials and database logins inside one coordinator; the runtime continuation separately deploys API/worker tasks and tests their actual ECS-issued credentials. These are distinct evidence sets. An implementing-agent review must not claim independence.
2. Review the exact deployed task roles, non-owner database logins, managed cursor/webhook secrets, matching protection evidence and Cognito configuration. The earlier CodeBuild-assumable recovery roles are not the deployed ECS task roles. `backend/src/operations/recovery-runtime.ts` requires a matching, reviewed and SHA-pinned protection file. The current file names implementation review. Refresh actual protection checks before replacing its expired record; do not extend dates without evidence or reuse records bound to different roles.
3. Review the runtime record's two-merchant/three-operator endpoint demonstration, exact package verification and open-capture revocation results. Complete the remaining deployed revocation scenarios during queued delivery and an active export stream; do not equate denying a new read with interrupting an existing stream. Merchant ownership and human contributor access are distinct: the demonstration must use a scoped merchant credential for independent merchant reads.
4. On actual web and Android builds, exercise permission denial, capture interruption, process termination/restart, lost responses during upload/finalization, resume under the wrong account/Proof and revocation. Record build ID, device/browser, operator, steps and retained-recording outcome. Preserve SIGNAL presentation.
5. Verify the client repairs and exact candidate CI described in [22 October continuation](RELEASE-CONTINUATION-2026-10-22.md). The owner authorized full release and AWS access is restored. Do not treat green backend CI as a green full release, or bypass the old release operator's incompatible migration inventory.
6. Record the reviewer's name, date, source commit, evidence digests, unresolved findings and explicit GO/HOLD decision. Collin selects and authorizes a consenting live merchant cohort separately. No synthetic test counts as merchant adoption.

M2's reusable SDK and detached signed profile remain gated. M3/M4 require demonstrated demand and M5 requires a stable profile and independent conformance. Existing source is not evidence that these milestones have been executed.
