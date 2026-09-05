# Signature experience contracts

The signature service adds versioned reading and interpretation over the existing Proof. It never changes a frozen core manifest, grants a participant role, or assigns authenticity, liability, fraud, or claim outcomes. Migration 029 creates additive tables. Its mutation guards preserve snapshots, bookmarks, packets, approvals, comparison interpretations, consent events and history assertions.

## HTTP surface

All routes below are mounted under `/proofs/:id/signature` behind human authentication. Every request independently verifies contributor access. Guest disclosure tokens alone cannot call these endpoints. Accepted commerce receivers receive a separate stage-only snapshot for their finalized commerce Proof. It withholds outbound originals, original chapters and hashes, detailed order fields, private statements and cross-transaction history. An older participant snapshot or case ID cannot bypass that scope. Raw source playback uses the existing authorized media delivery routes.

| Route | Contract |
| --- | --- |
| `GET /` | Capabilities, immutable snapshot, comparisons and opted-in history preview. Optional `snapshotId` selects an existing authorized snapshot for an exact deep link. |
| `GET /snapshots/:snapshotId` | Exact existing snapshot; verifies payload hash and Proof binding. |
| `POST /outbound-view` | Explicit supplied `token` resolves one current central disclosure grant for this same Proof. Returns its reviewed view; never upgrades access to full snapshots, original fallback, history or persisted comparison references. |
| `POST /anchors` | `evidenceId`, optional `stageId`, integer `startMs`/`endMs`, `label`, `sourceType`, `idempotencyKey`, optional bounded `recipeVersion` (for example `PACKING_STANDARD_V1`). Event anchors use `eventId` without elapsed time. Optional `supersedesId` appends an author's correction. |
| `POST /ask` | `snapshotId`, `question`; deterministic response with supported source citations or explicit `NOT_ESTABLISHED`. |
| `POST /cases` | `snapshotId`, `template`, optional `notes` and `scope: { fields, evidenceIds }`; builds a frozen recipient preview without dispatch. |
| `GET /cases/:caseId` | Exact preview and approval state. |
| `POST /cases/:caseId/approve` | Creator supplies the exact `previewSha256`; approval is append-only and idempotent. |
| `GET /cases/:caseId/export` | Approved structured JSON packet and artifact SHA-256 header. |
| `GET /cases/:caseId/export.html` | Approved, escaped, printable HTML packet with the same snapshot and preview identity. No scripts, external fetches, automatic claim submission or embedded original media. |
| `POST /comparisons` | Snapshot, outbound/inbound anchor IDs, optional asset ID, observation state/note and optional correction reference. |
| `POST /history/consent` | Seller explicitly chooses `optIn: true` or `false`; withdrawal remains available if history is disabled. |
| `POST /history` | Current and previous asset IDs, previous Proof ID and asserted linking basis. Requires current access and separate consent to both source Proofs. |
| `POST /history/:linkId/events` | Append `CORROBORATED`, `DISPUTED` or `CORRECTED` plus a note. A different authorized participant must corroborate. |
| `POST /history/preview` | `recipientUserId`, selected `linkIds` (1–25); checks independent sender/recipient source access and produces exact recipient preview/hash. |
| `POST /history/share` | Same selection plus `previewSha256`; approves a selected authenticated handoff without messages or new source grants. |
| `GET /history/shares/:shareId` | Creator/recipient only. Returns current selected view, approved/current hashes and whether the view changed; withdrawn sources are unavailable. |
| `POST /history/shares/:shareId/revoke` | Creator appends revocation; future handoff reads fail closed. |
| `GET /usage` | Actor-scoped daily request, failure, elapsed processing and served-byte totals. No questions, customer media or model prompts are logged. |

Detailed TypeScript types are exported from `backend/src/domain/signature.ts`. All responses use private, noncacheable HTTP delivery. Browser and native clients must preserve the snapshot identity when asking or approving; automatically substituting the latest record is incorrect.

## Replay and source time

Chapters reference one committed root or lifecycle original using its digest and `sha256:<digest>` source version. Ranges are recording-relative milliseconds, never filming-time attestations. A known server-probed duration rejects out-of-range chapters. Legacy or container sources with no independently available duration return `DURATION_UNAVAILABLE`; clients must make this limitation visible and keep ordinary playback usable.

Recipe version is optional assistance metadata and participates in chapter idempotency; it cannot be changed on a retry or treated as a different evidence standard. Source media retain their actual capture session ID and any appended `clientReportedCapture` interruption/duration context. That context explicitly says `CLIENT_REPORTED_NOT_INDEPENDENTLY_VERIFIED` and is kept separate from server-probed media duration. An immutable snapshot captures the context visible at its creation.

Event anchors hash the original immutable audit/shipping source, not a mutable display title. They carry `SOURCE_EVENT` timing and never pretend to be video ranges. User and scanner bookmarks remain labeled observations. No machine-generated evidence is created.

The bounded snapshot contains at most 200 media sources, 300 chapters, 300 comparison interpretations and 1,000 chronology events. Larger records continue to use the ordinary viewer. Labels are limited to 120 characters; ranges must be nonempty and no longer than the six-hour recording boundary. Any annotation failure leaves committed original bytes and Proof finalization untouched.

## Deterministic questions

Supported intents cover recorded order title/quantity, available media, marked identifier/label/item/packing moments and reported chronology/shipping events. A response includes source category and a stable field, media, anchor or event reference from the requested snapshot. Missing sources produce abstention. The lookup does not call an AI provider, execute untrusted order/label text, or receive mutation tools.

Imported fields and later seller corrections use separate provenance labels, including historical correction events. Quoted order descriptions remain untrusted source data. Carrier reports remain carrier reports; they do not become buyer testimony or observations of contents. Tests assert that unsupported authenticity, fraud, address disclosure and instruction-injection questions abstain.

## Case packets

The three versioned templates are `MISSING_CONTENTS`, `WRONG_ITEM` and `CONDITION_RETURN`. The default packet selects all snapshot evidence and statements. A user can narrow fields and media before preview. The packet records that selection, source snapshot/digest, template version, original media index, issue-related chapters, participant statements, comparison observations/corrections, factual notes and gaps.

Known comparison observations excluded by the selected source scope generate an explicit incompleteness notice. Missing returns or carrier events remain missing. Rebuilding a template with the same snapshot, note and scope produces equivalent canonical content and the same preview digest. Approval verifies the exact digest before download; another participant cannot approve in the creator's place. Original media is referenced and requires its own current authorization; exporting the packet never creates a broader grant.

The HTML version escapes all source text and notes, blocks active content through CSP and reproduces the approved selection. It includes token-free workspace links to the selected Proof, exact snapshot and original/anchor references; these links still require existing authorization. Its artifact digest covers the actual returned HTML bytes. Exports are audited by preview and artifact digest. No external submission adapter is enabled.

## Return interpretations

A persisted pair requires participant access and must contain a committed outbound anchor and a distinct receipt/return-stage anchor in the same requested snapshot and Proof. A receipt-only receiver can inspect expressly shared outbound media through `/outbound-view` and the grant's scoped media route, but cannot reuse a full source snapshot or bypass original permissions. If no grant is supplied, outbound evidence stays unavailable. Optional asset IDs must belong to that Proof. Valid states are `OBSERVED_DIFFERENCE`, `NO_VISIBLE_DIFFERENCE` and `NOT_COMPARABLE`. Notes retain author, time, source references and corrections. These are human observations, never findings against a buyer. Both original elapsed times stay separate; alignment is presentation only.

## Item history

History uses existing Proof assets. Matching text/serials do not merge assets or create links. Both Proofs must opt in and the linking actor must independently have access to both. Each asset is checked against its stated source Proof. A serialized graph check rejects cycles. Every subsequent read rechecks current consent and access; unavailable entries disclose only their opaque history-entry ID and an unavailability explanation.

Consent is append-only and ordered by a database sequence so same-time withdrawal cannot accidentally select an older consent. A later owner does not inherit another participant's private records. Disputes stay visible even if a later correction is appended. The history is explicitly partial and makes no ownership or continuous-custody guarantee.

Selected history handoffs are restricted to already authorized participants in this release. The sender previews 1–25 selected entries as the intended recipient, approves the exact preview hash and receives an authenticated path. The handoff creates no additional Proof roles, messages or media grants. Every read rechecks both parties' access and each source's consent; withdrawn entries reveal no asset IDs or assertion text. Later observations can change the current preview, which is explicitly distinguished from its approved hash. The creator can revoke the handoff without deleting source assertions.

## Flags, measurement and rollout

`PACKPROOF_FEATURE_REPLAY`, `PACKPROOF_FEATURE_ASK`, `PACKPROOF_FEATURE_CASES`, `PACKPROOF_FEATURE_COMPARE` and `PACKPROOF_FEATURE_HISTORY` independently disable optional creation/actions with `0`, `false` or `off`. They are evaluated at request time from the runtime configuration. Existing snapshot reads remain available. `GET /` returns capabilities for clients and `paidAI: false`.

Usage is aggregated per actor, Proof, feature and UTC day. Model tokens and paid AI use are zero for this release. Processing time and served bytes are measurement inputs, not a claim of actual infrastructure charges; reconcile billing separately. Capture and original viewing do not depend on these metrics or optional features.

Automated checks cover source/version/range binding, cross-Proof isolation, immutable snapshots, corrected field provenance, structured abstention, all three templates, exact approval, scoped exports, hostile HTML, paired return sources, original manifest stability, cloned identifiers, consent withdrawal, cyclic history, appended disputes and independent feature flags. Device and unfamiliar-user targets from the development plan remain release gates that must be measured on the deployed builds; backend tests do not establish those targets.
