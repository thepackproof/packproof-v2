# Connect shipment-first onboarding implementation

Baseline: `a9568101df67722a6b03f44154e99c5598f60021` (`main`, November 13, 2026). Desktop/service candidate: **0.1.2, development channel, unsigned/internal only**. This implements the attached November 13 replacement specification in the existing application, service, importer and browser approval routes. It is not a production-deployment or customer-acceptance receipt.

## Investigation and reuse map (W0)

The original screenshot CSV, installed executable and protected installation state were not supplied. The precise origin of the screenshot's selections remains **unproven**; there is no evidence here that those selections created production records. The four-column fixture is explicitly synthetic.

Reproduced defects on the pinned baseline: `parseShipmentCsv` inferred shipment identity from `Order ID`, and invented a title and quantity when absent. The first four-test regression failed the identity and missing-value cases before changes. The UI counted nonempty selections without validating them, hydrated pending/approved mappings without raw-value revalidation, and built cards from shortened samples. This is an unsafe boundary, not proof of the screenshot's particular hydration history.

Existing canonical semantics are one immutable shipment observation per source/location/reference. Conflicting repeated references are held, rather than silently aggregated into line items. The positive integer quantity contract is 1–100,000. Description/reference limits are 200 characters; carrier/tracking limits are 100, matching the canonical transaction contract. No reduced-data record schema or unit conversion was introduced. The shared one-time CSV importer also stops inventing missing contents/quantity: older exports that relied on those defaults must now supply the real columns and values. Historical canonical records are not modified. Existing integrity/authorization tests use explicit valid source fields; their assertions remain intact.

| Existing boundary | Implementation |
| --- | --- |
| `connect-windows/ui/ConnectApp.tsx` | Three actual stages, service-validated shipment card, focused clarification, secondary mapping/provenance/settings, explicit full-original disclosure and observed completion |
| `service/FolderSource.cs`, `CsvSemantics.cs` | Bounded original-byte parsing and all-row checks; exact headings plus normalized-collision checks; display samples remain display-only |
| `service/AgentSetup.cs`, `AgentRuntime.cs`, `Models.cs` | Protected draft/revision/baseline state, resumable guided orchestration, exact receipt approval, parity and canonical/provenance verification |
| `main/`, `bridge/` | Narrow typed `analyzeLocal` and `startSetup` operations, trusted browser route, existing isolation and service-peer checks |
| `backend/src/records/csv.ts`, `csv-semantics.ts` | No order alias or fabricated required values; deterministic semantic rules shared with local analysis |
| `agent-enrollments.ts`, `agent-restrictions.ts` | Existing exact configuration/receipt/recurring actions, v2 contract, raw-row validation and current binding enforcement |
| `partner-imports.ts` | Same importer, queue, original preservation, idempotency and canonical Proofs; all raw locations checked even when a row cannot normalize |
| `web/src/records/AgentConnections.tsx` | One browser review observes successive existing requests, shows actual normalized receipt, preserves separate approvals and resets consent on target changes |

## Contracts and operation (W1–W5)

`backend/src/records/connect-csv-rules.json` is the canonical alias/range/version definition. TypeScript imports it; C# embeds that exact file. Both run `backend/tests/fixtures/connect-csv-corpus.json`. Decisions distinguish validated, needs confirmation, missing required/optional, and incompatible. A recognized but incompatible heading cannot be confirmed into another business role. An unknown heading needs explicit meaning confirmation and the same value checks. No fuzzy or LLM matching was added.

The service binds the card and proposed configuration to installation, folder fingerprint, original SHA-256, header fingerprint, profile/rule version and draft revision. Changing columns triggers fresh service analysis. Changing the original before commit stops setup and retains the receipt. Late renderer responses cannot replace a newer action's result. The server rejects incompatible configuration headings and repeats full-value checks before preservation/commit and in the worker authorization path.

`packproof.scheduled-csv/v2` is an additive JSON contract over existing configuration storage. It explicitly supports null exporter name/version and null export cadence. `source-offset` means preserve each supplied timestamp's offset and source calendar date; it is not an inferred IANA zone. Polling remains the existing 30-second collector policy. Scheduled sources still require valid explicit-offset timestamps.

The default shipment-event cutoff is the earliest valid instant in the selected report, visibly disclosed. The separate local filename baseline is captured when that report is selected and stored in protected service state. Its hash and observation time are approved with the configuration. The selected report is imported once; other existing names are skipped, including later modifications under those names. Newly arriving names must meet the approved exact schema, mapping, history and file limits. Missing baseline state pauses collection. This does not claim older-folder backfill support; that requires a separately scoped source review.

`Approve and connect` persists local full-original consent and proposes the exact configuration before opening its trusted route. Configuration approval permits upload only for the approved initial SHA-256. The browser then discovers an existing receipt for that installation/revision/hash; it never approves an unknown future receipt. Service commit waits for that exact `testImportId`. All normalized rows must agree locally and remotely. After terminal receipt reconciliation the service retrieves a canonical Proof and checks values, record identity and source audit provenance. A separate heartbeat acknowledges that exact verified receipt; the server independently checks canonical values and associations before enabling recurring approval. Recurring policy approval remains distinct. Only then does the service acknowledge active collection.

Configuration and first-batch reviews expire after 30 minutes. Enrollment retains its existing expiry and comparison code. Denial/revocation never imply success. Pausing setup retains all original/receipt ownership; already accepted server work can finish. Reopening resumes protected acknowledged state. Incompatible saved mappings cannot retain an active label or pass a queued-write boundary; their protected evidence remains preserved. Invalid legacy value mappings are held when revalidated; supported legacy contracts remain readable. Approving a new configuration explicitly supersedes only uncommitted old previews as `action_needed`; original objects, rows and receipts remain intact, avoiding a permanently unresolvable preview during credential renewal.

Already imported rows can reference their existing accessible canonical Proof after exact review and verification. They do not claim a new record. Conflicting observations still require the existing append-only correction process. No customer history, queue, keys or originals were cleared.

## Validation evidence

Local checks recorded during implementation:

| Check | Observed result |
| --- | --- |
| Baseline screenshot-style regression | Two intentional failures reproduced; corrected tests pass |
| Shared semantic corpus | 18 synthetic cases executed by TypeScript and C#; includes wrong selections, long/leading-zero IDs, row 11 invalidity, identity ties, normalized collisions, date/quantity conflicts, script/formula text, location conflict and mixed granularity |
| Backend selected contract/integration suites | Exact configure → preview → batch approval → commit → canonical retrieval → verification → recurring grant → subsequent import; re-export reuses the same Proof; changed initial hash and schema drift rejected |
| Desktop component/security/state tests | 44 passing locally; native packaging checks are recorded separately |
| C# service/queue/recovery tests | Linux run: 98 passing portable cases; five Windows-only cases are explicitly skipped locally. Guided transport tests prove restart, approval order, no false activation and preserved mismatch failures; these are not native-installation passes |
| Backend TypeScript build | Pass |
| Browser client TypeScript/build and focused approval tests | Pass; final checks recorded by CI |
| Desktop TypeScript/build and six release-policy checks | Pass |
| Windows service cross-build | Pass, no warnings/errors; execution is qualified separately |

The candidate workflow builds on native Windows and exercises the packaged LocalService, restricted bridge, DPAPI, standard-user and storage-repair tests. Its foundation smoke now also checks the validated shipment response, unknown metadata and screenshot-like tampered mapping through the actual installed service. Check the workflow's immutable run/artifact receipts for the final commit. Windows Server CI is not Windows 11 customer acceptance.

## Outstanding release gates (W6)

These remain unverified until there are actual results; mocks do not close them:

- Clean, repair/reinstall, upgrade with pending work and interrupted upgrade on supported Windows 11 x64, including keys/queue continuity under the real service identity.
- Authenticated installed-product/browser/hosted-API first record and a second unattended export after closing the UI; reboot, offline expiry and revocation on that environment.
- Installed screenshots; keyboard/screen-reader/high-contrast and 125/150/200% scaling checks. The available browsers could not reach the isolated local preview; component rendering tests are not visual acceptance.
- Five nontechnical participants, at least four unaided completions, measured effort, and understanding of upload destination/full originals/active state. No participant results are invented.
- Signing identity and signed staging/production bundle qualification. An unsigned development artifact is not customer-ready.
- Separately authorized staged/backend/browser rollout, observed deployment receipts and production qualification. Nothing in this implementation record claims deployment.

Original screenshot build/state and source-data provenance are still unavailable, so the exact screenshot root cause and any historical production impact remain unresolved.

## Rollout and rollback

Release additive backend validation/capability support first, then the browser review, then a qualified matching desktop/service candidate to an internal cohort. New clients refuse servers without the matching rules capability before reading/uploading the initial original. Old clients cannot read v2 contracts and must fail closed; do not assign a v2 configuration to an old service as a migration shortcut. Valid legacy v1 configurations retain their existing explicit metadata and semantics.

If a regression appears, pause the affected source/installation through the existing controls. Preserve protected data and receipts. Roll forward with a compatible desktop/service patch, retaining backend semantic rejection. Do not roll back to accepting unsafe mappings, reinterpret old queued originals with a new revision, or delete ProgramData/SQLite/keys. A prior binary can be used only with an explicitly compatible source contract and fresh required approval. There is no database migration to reverse.
