# Mobile UX capture inventory

Inspected before implementation on `195bf920ce77249631702ad5f48dc51e52ed019a`, October 9, 2026. This inventory covers native capture and recovery. It is source evidence, not a physical-device acceptance report.

## Ownership and invariants

- `mobile/src/capture.ts` persists account, API origin, Proof, stage, session and operation identity before acquisition. Native media has a unique document-storage path. Serialized metadata writes preserve its recovery identity.
- Android and iOS unified camera implementations publish `.finalized.json` only after successful native finalization and journal completion. Restart recovery promotes an interrupted recording to reviewable local work only after finding this marker. Partial video bytes remain retained; no repair or segment stitching is implemented.
- `capture/completion.ts` prepares exact media and obtains the existing explicit biometric declaration. The durable `submitRequested` flag precedes the upload handoff. Returning Home does not delete the original.
- `capture/recover-completion.ts` rechecks the exact server evidence identity before resending or committing. Upload, commitment/preservation, attestation and finalization have distinct states. Receipt loss can be recovered without substituting another recording.
- `app/PackProofProvider.tsx` owns account-scoped scheduling, foreground/connectivity reconciliation, authorization renewal, discard and cleanup. Cleanup requires fresh evidence and finalization receipts. Sign-out retains account-bound recording journals.
- The native station uses the same completion coordinator. A continuous native video and explicit seller statement remain the normal capture model. Barcode reads remain observations and are not substitutes for captured media.

## Verified discrepancies and bounded changes

- Shared recovery copy checked offline before unconfirmed local work, incorrectly promising automatic upload for a recording still needing review. Presentation must preserve the confirmation prerequisite.
- Review copy combined transferred bytes and committed evidence into an implied finalization step. Display each milestone without predicting success.
- The camera's primary control followed optional guidance inside the information scroll area. Place the control first and preserve scroll/reflow for large text. Keep explicit finish-or-continue handling on Android Back.
- A live accessibility region announced a continuously changing timer. Announce recording state separately from elapsed time.
- `RECORDING` journals without completion markers must not expose review or resume-upload actions. Explain the retained incomplete take and offer deliberate discard before a new continuous recording. Missing files also require a distinct state.
- Existing optical/identifier decisions, biometric declarations, integrity checks, idempotency, and finalization behavior must remain unchanged.

## Validation boundaries

Existing automated coverage includes lost upload/commit/declaration responses, account transitions, expired authorization, exact evidence identities, durability receipts, discard intent, missing originals, and stage-specific receipt ownership. New tests cover recovery presentation and truthful milestone mapping. Native layout, screen reader, force-stop, camera permission, low storage, and biometric behavior require physical-device validation. No attached physical device was available during this implementation.

These changes do not touch web layouts, backend contracts or native encoder code. Reverting the mobile presentation commits does not migrate, delete or reset persisted capture journals.

## Implemented observability

`analytics/mobile-ux-events.ts` retains a fixed set of numeric aggregates only in memory. No media, tokens, record identifiers, addresses, tracking numbers or network transport are accepted. The account boundary clears the aggregates and any pending entry timer. A deliberate task-start timer measures camera-surface entry; durable-save events follow successful nonempty media and journal persistence. Review completion follows explicit preparation/consent, and commitment/finalization counts require observed server transitions. Repeated successful reconciliation does not count another completion. Terminal recovery errors count a user intervention when their code changes.

These conservative session observations are not a production analytics baseline: process termination clears them, and a lost response can leave an observed-transition count absent. Existing consented study instrumentation remains unchanged. Do not infer abandoned drafts, improvement percentages or end-to-end delivery rates from these counters alone.
