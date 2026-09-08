# Design and state contracts

This is the intended cross-client contract with source anchors from the current implementation. Final screenshots and physical accessibility evidence remain pending. Keep the approved PackProof icon and wordmark; the redesign changes workflow and hierarchy, not the brand identity.

## Semantic colors and text

`mobile/src/theme/tokens.ts` supplies shared semantic roles consumed by Android and the web theme. Current candidate values:

| Role | Light | Dark | Meaning |
|---|---|---|---|
| Background / surface | `#F7F8FA` / `#FFFFFF` | `#16181C` / `#21252B` | Quiet neutral structure. |
| Primary / secondary text | `#18212C` / `#5A6472` | `#F3F5F7` / `#BAC2CC` | Readable hierarchy. |
| Interactive action | `#1767D1` | `#78ACFF` | Actions, selection and focus. |
| On-action text | `#FFFFFF` | `#10233F` | Label against the primary fill. |
| Success | `#137548` | `#83D4A5` | Confirmed positive outcome, never a substitute for authoritative completion. |
| Warning | `#9A6817` | `#EAC079` | Meaningful caution. |
| Destructive | `#B42318` | `#F3958C` | Destructive consequence. Sign-out remains quiet. |
| Border | `#DCE3EB` | `#3C444E` | Subtle separation. |

Spacing steps are 4, 8, 12, 16, 20, 24, 32 and 40. Titles use 28/34 or 22/28, sections 18/24, row titles 16/22, body 16/24 and metadata 14/20. Native touch minimum is 48. Dimensions must grow with text; do not cap font scaling to hide clipping. Web settings use native disclosure and radio controls with visible keyboard focus.

Source compatibility aliases still exist. Their action/success mappings are now distinct; audit callers for inappropriate static/light-only usage before T20 is closed. Persist explicit light/dark/system choices. Fresh-user light default must not replace an existing preference. Every semantic color pairing and state still requires rendered contrast/accessibility checks.

## Route and action contract

| Context | Entry and primary action | Exit / recovery |
|---|---|---|
| Orders | Ready order row opens camera preview with its order; recording starts only by deliberate Record action. | Return to the originating queue/scroll position. Keep pending work above new orders. |
| No connected/eligible order | One Record shipment action; Connect marketplace is secondary. | Minimal item context, then the same camera. Pasted information remains participant-supplied. |
| Proofs | Needs attention and Saved Proofs follow canonical lifecycle. | Old links still reach the same permitted Proof. Pending uploads are visible. |
| Batch | Pack multiple orders is secondary in Orders; queue selects one order. | Same capture/review/completion; only authoritative completion removes finished work. Never auto-start the next camera recording. |
| Capture preview | Item/package guidance and intentional Record packing. | Back does not delete journals or originals. A stale legacy station must not substitute another Proof's context. |
| Review | Original playback, brief source-correct label status, exact shipping declaration. | Missing label can remain explicitly missing; unresolved observed conflicts need an attributed decision. No separate scan/photo chore. |
| Saving | Honest local, uploaded, committed, declaration and finalization facts. | Exact durable reconciliation resumes stable IDs. No success celebration solely because bytes are local or uploaded. |
| Completed | Proof saved/locked derives from server root state. | View/share Proof; return to Orders or batch. Retained original stays until required preservation receipt. |
| Account | Compact Profile, Sales channels, Recordings, Appearance, Help, Privacy/account rows. | Profile Save appears only after changes; sign-out is quiet; hardware Back closes a subpanel first. |
| Public deletion resource | `/new/delete-account` is available before authentication. | Explain retention and sign in; only explicit authenticated confirmation submits. Sign-in returns to this route. |

Android `navigation.ts`/Root/provider and web `App.tsx` own actual routing. Route tests must verify these requirements rather than treating this table as proof of wiring. Batch/ordinary capture must not share stale label/session ownership. Preserve old capture, receiving, return and grading deep links in their permitted context.

## Corrections and source attribution

| Record context | Order/shipping correction | Required interpretation |
|---|---|---|
| Manual, seller-owned, before binding a packing capture | Allowed where server policy permits. | Keep attributed participant-supplied source. |
| Imported marketplace/storefront/provider facts | Read-only through normal UI and direct API. | Source revisions are append-only observations; do not replace the snapshot used by the capture. |
| Packing capture setup has bound context | Locked against stale correction requests. | Preserve the original and its order association. |
| Material context differs from a signed challenge | Old challenge must be rejected. | Obtain new exact authorization; no signature reuse for a changed payload. |
| Finalized root | Immutable. | Later tracking/receipt/return data is a separate permitted supplement/stage. |
| Label belongs to another package | Explicit attributed resolution; observation remains. | Never silently move the recording to a different order. |

Server sources: `transaction-correction-policy.ts`, `attestation-context.ts`, `capture-label-review.ts`, `finalize.ts`, and migration 052. Client selectors improve presentation; they are not the authorization boundary.

## What the evidence display may say

- A preview observation is not proof that the label appears in encoded frames. Encoded-video inspection has a separate source/coordinate space. Generated local thumbnails identify the original and use the reported **near requested** timestamp precision; do not relabel them as exact frame time.
- Activity grouping retains every source event. The web rule groups matching known actor/link/source inside a fixed 30-minute UTC window. Unknown actors without a known link remain separate. Counts mean access events, not unique people.
- Tracking distinguishes no tracking, no carrier scan, pending lookup, unsupported service, disconnected service, failed/delayed sync and actual reported movement. Preserve known observations during an outage. A redacted tracking number does not imply a missing label.
- Shared/workspace/mobile viewers consume one record and permission-scoped facts. Public projections must not reveal private raw audit, owner-only corrections, credentials, full label data or revoked media access.
- Account deletion records a request and its status. It is not immediate deletion, a promise to erase immutable evidence, or proof that operational review has been completed. Terminal server states must be labeled accurately.

## Screenshots and accessibility evidence to attach

Empty/loaded Orders; pending recovery; camera preview; missing-label/mismatch review; exact statement at 200% text; saving; completed Proof; Recording/Activity/Tracking; channel unavailable/reconnect/sync-failed states; Account disclosure; local-copy management; public/signed-in deletion; narrow web viewer; light/dark/system. Include both phone models, keyboard/TalkBack focus and actual rendered overflow/contrast observations. No screenshot is currently recorded as approved by this proposal.

## Consented task instrumentation

Migration 053 extends the existing opt-in timing store with 13 finite interaction names and an optional lowercase 40-character build SHA. Clients report order selection, actual recording start/stop, label read/mismatch, review, confirmation/cancellation/failure, upload pending, authoritative completion observed by the client, recovery and actual share creation. Arbitrary fields are rejected or stripped before persistence. No original frames, order/Proof IDs, labels, tracking strings, names, credentials or biometrics enter this subsystem.

Build SHA comes only from the explicit build environment, is omitted when unknown, and remains client-reported attribution. Native/web timing phases retain separate capture, review and infrastructure waits. Order selection and sharing use interface_action and never inflate capture-start/effort denominators. Failed/withdrawn or changed-account operations retain the existing fail-closed consent handling; consented events do not claim independent verification of real-world events.
