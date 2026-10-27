# Enterprise pilot verification

**Verified runtime code:** `ea40a8f5624e65d9580a99ec96f2fcd3f570b463`  
**Result:** Successful dedicated [Enterprise pilot acceptance run](https://github.com/thepackproof/packproof-v2/actions/runs/40447090950).  
**JUnit artifact:** [Enterprise API acceptance evidence](https://github.com/thepackproof/packproof-v2/actions/runs/40447090950/artifacts/12708617798).

| Check | Result |
|---|---|
| API TypeScript | Passed |
| Web TypeScript | Passed |
| Generic original-file import CLI syntax | Passed |
| Enterprise API/domain/database acceptance | 12 tests passed |
| Existing consumer merchant capture → attestation → finalize | 1 existing test passed; 8 unrelated tests intentionally not selected |
| Reviewer workspace | 3 tests passed |
| Backend build | Passed |
| Web build | Passed |

The final code checks use PostgreSQL-compatible PGlite, the actual Express app, private local object storage, the existing capture fixture/media tools and component-level browser DOM tests. These are not a production PostgreSQL/S3 deployment, hardware capture test or Winsupply reviewer acceptance.

Verified scenarios include complete and split multi-line fulfillment, significant native identifier preservation, approved cross-source namespaces, distinct merchant owners, explicit human site access, source-granted machine isolation/revocation, immutable source records, byte-identical originals, digest failure rejection, late original association, idempotency and rerun status, unknown/mixed units and timestamps, out-of-order source revisions, reasoned ambiguous association, server-timed baseline/pilot review, strict CSV, historical/feature gates, and finding reviewer association targets beyond the first page.

## Release disposition

- Runtime code is ready for review and isolated synthetic pilot preparation.
- No production migration, deployment, IAM grant, customer communication or Winsupply data import was executed.
- Enterprise behavior is disabled by default.
- Actual historical admission still requires site/IT/data-owner permission, verified source semantics, agreed retention/deletion, and the storage/document-security preflight.
- Recurring connectors and additional capture remain conditional on approved actual pilot results.
- The documentation-only commit after the verified runtime SHA records this evidence without rerunning unrelated native/research release matrices. It changes no executable code.

See [implementation status](README.md), [API contract](API.md), [pilot charter](PILOT_CHARTER.md), [reviewer walkthrough](REVIEWER_WALKTHROUGH.md), [operating gates/rollback](SECURITY_OPERATIONS.md) and [evaluation template](EVALUATION_TEMPLATE.md).
