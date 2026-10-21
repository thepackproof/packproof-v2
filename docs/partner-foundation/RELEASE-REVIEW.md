# M1 review handoff

Recommendation: **HOLD**. This is the implementer's evidence packet, not independent M1-06 approval. The attached development plan requires an independent release recommendation and actual device acceptance before advancing the full M2 SDK/developer platform.

## Evidence to inspect

| Boundary | Evidence | What it establishes |
| --- | --- | --- |
| Additive migration and historical compatibility | `isolated-migration-evidence-2026-10-20.json` | 86 historical migrations, five additive migrations, two signed synthetic fixtures and 14 unchanged frozen entries; seven real PostgreSQL checks |
| Private storage and database | `isolated-deployment-evidence-2026-10-20.json` | Exact new resources, TLS, encryption, private database, two independently locked buckets and signing keys |
| Application-role preservation and recovery | `isolated-recovery-evidence-2026-10-20.json`, `infra/partner-foundation/RECOVERY-DRILL.md` | Actual scoped role denials, retained exact object versions, externally fenced existing sessions and fresh-target reconstruction; see result and limits in the record |
| Required MFA | `isolated-identity-evidence-2026-10-20.json`, `infra/partner-foundation/IDENTITY.md` | Nine synthetic Cognito checks, removal of the temporary user and runner; no deployed application identity certification |
| Application correctness | `ACCEPTANCE.md`, PR #108 | Full backend tests at the stated application commit; focused PostgreSQL, contract and transport checks at later runner commits |

Private archives contain synthetic source packages, signed heads and trust material. Their exact S3 object versions and SHA-256 hashes are recorded in the evidence files. Grant a reviewer read-only access through the account's existing access process; do not make the buckets public or send bearer credentials. Review source and evidence at a pinned PR commit.

## Remaining release work

1. Have an independent reviewer inspect trust establishment, role separation, retained-version selection, policy completeness and old-writer fencing. The current drill uses separate SDK credentials and database logins inside one coordinator; it does not establish deployed API/worker process separation.
2. Provision the separate test API and recovery-worker processes with their own workload trust, non-owner database logins, managed cursor/webhook secrets, reviewed protection evidence and the new Cognito pool. The acceptance roles are temporary CodeBuild-assumable roles and must not be relabeled as deployed task roles. `backend/src/operations/recovery-runtime.ts` requires a matching, reviewed and SHA-pinned protection file. Do not invent `reviewedBy` or reuse an evidence record for different role identities.
3. Run the complete two-merchant/three-operator demonstration through authenticated endpoints and private media storage. Include credential/grant revocation during in-flight capture, queued jobs and export; record the actual response and durable state.
4. On actual web and Android builds, exercise permission denial, capture interruption, process termination/restart, lost responses during upload/finalization, resume under the wrong account/Proof and revocation. Record build ID, device/browser, operator, steps and retained-recording outcome. Preserve SIGNAL presentation.
5. Resolve the baseline web/mobile release failures and record the exact candidate CI result. Do not treat green backend CI as a green full release.
6. Record the reviewer's name, date, source commit, evidence digests, unresolved findings and explicit GO/HOLD decision. Collin selects and authorizes a consenting live merchant cohort separately. No synthetic test counts as merchant adoption.

M2's reusable SDK and detached signed profile remain gated. M3/M4 require demonstrated demand and M5 requires a stable profile and independent conformance. Existing source is not evidence that these milestones have been executed.
