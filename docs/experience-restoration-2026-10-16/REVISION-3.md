# Revision 2 approval follow-through — October 17

The founder approved the revised design direction and implementation, required correction of the premature photo checkmark, and retained native integration tests as a release condition. Typography, spacing, warm paper, blue actions, Evidence naming and completed-state presentation are frozen. This is a targeted correction, not a new design candidate.

| Review request | Implemented behavior |
| --- | --- |
| Item photos completion | The prototype step uses the item acknowledgment, never local photo count or file commitment. Both accepted photos show Save pending; committed files show Item confirmation pending. The progress step remains visible during checking, timeout and reopening. Packing becomes active only after acknowledgment. Native photo completion continues to require the actual workflow response in the existing submission owner. |
| Trustworthy Home actions | Prototype recommendations execute their named action on the exact Proof, including save reconciliation and pending photo checks. Checking never fabricates artifact commitment or finalization, and offline checking retains the unresolved state. Native Home carries the exact photo draft ID into the existing recovery owner, replays already-authorized submissions, then fetches the Proof. Local-only photos still require explicit submission. Stale/different-account/different-item tasks are rejected. Home Refresh Proof fetches the selected full snapshot, manifest and integrity instead of refreshing only the workspace list. |
| Presentation details | Singular/plural Proof and incoming-task copy; long headings, step captions and controls may wrap. Task and confirmation cues change opacity without moving the screen. Native state transitions retain child/player identity and stop immediately with reduced motion. |
| Native validation | The device matrix now explicitly includes held-ack pending indicators and Home action request/receipt evidence. Current ADB daemon startup fails; browser runtime startup also fails. No physical-device, rendered 200% layout, TalkBack or codec result is claimed. |

## Reproduced checks

- `verification/revision3-native.txt`: 95 passing tests, including 11 actual Home/provider command tests, exact-draft and cross-account rejection, duplicate taps, late-navigation cancellation, photo retry/late responses, existing entry/request owners and stationary/reduced-motion component behavior. Network and native I/O ports are substituted.
- `verification/revision3-dom.txt`: 24 passing interaction checks across the eight existing scenarios. New checks cover pending photo progress through timeout/reopen, recommended save/photo actions, offline checks and singular copy. Opaque embedded media bytes are omitted only in the DOM harness to avoid repeatedly parsing megabytes; full standalone-file asset assertions use the original generated file. No rendering or playback claim.
- `verification/revision3-prototype.txt`: 41 passing fixture lifecycle and actual CSS palette contrast checks. Existing design tokens are unchanged.
- `verification/revision3-typecheck.txt`: 809 source files, zero errors using installed dependency resolution. Clean-install CI and the exact-source internal APK provide separate build checks.

## Demonstration

1. Item photos: hold the sample item-step response, accept Back, and save. Item photos remains pending even though both file rows say Saved to PackProof. Trigger timeout and reopen; it stays pending. Deliver the item acknowledgment; only then does its checkmark appear and packing become active.
2. Returning Home: choose Check save status. Its exact Proof opens and the event log records RECONCILE; the pending upload does not become finalized. Other Proofs retain their state. Returning Home after a held photo acknowledgment exposes Check photo save, which executes the item check.
3. Create one stopped take and keep it on Home: 1 Proof in progress. Use 200% text and reduced motion. Structural wrapping and motion behavior are tested; rendered layout still needs the browser/device pass.

The review HTML remains an interaction prototype with sample media and explicit simulated receipts. The production endpoints, manifest contract, server finalization rules and original media ownership are unchanged. No release, main merge, deployment, store version bump or study completion is implied. Follow [ANDROID-VALIDATION.md](ANDROID-VALIDATION.md), then the formative and fresh-user gates in [ACCEPTANCE.md](ACCEPTANCE.md).
