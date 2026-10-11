# Native first-experience measurement evidence

Implemented in the measurement branch on 2026-10-11. This is source and automated-test evidence; it is not evidence of a deployed backend, signed native release, physical-device camera performance, or store publication.

## Collection boundary

All events use the existing explicitly consented `/study` dataset and `capture-timing-study-v1` consent. No entry, selection, help, camera or authentication study journal is created without a cached explicit grant. Sending rechecks live consent. Account and API scope fence local journals and retries. Local withdrawal stops collection and removes only the account's study data. Captures and their recovery records remain intact.

The payload contains predefined event names, observed timestamps, bounded duration counters, optional valid installed version/build identity, flow version, platform, entry source, network state and material upload state. Account IDs, Proof IDs and API scope are used only for local lookup; they are not copied into study payloads. Passwords, tokens, email addresses, order values, error text and media are excluded.

Fresh unauthenticated visitors and new signups are outside this native study cohort. Authentication events apply only to reauthentication of an account with an existing study grant. These bounded events remain local while signed out and can send only after that same account signs in.

## Actual triggers

| Event | Native trigger |
| --- | --- |
| `entry_viewed` | Authenticated task-home entry under the existing grant. |
| `start_selected` | Deliberate manual creation, order capture or deep-link capture selection. The timestamp is captured before asynchronous study storage or network work. One unfinished study task survives retries and is joined to the eventual capture. |
| `capture_ready` | Unified camera `onReady` or Expo camera `onCameraReady`. Mounting the capture host does not produce this event. |
| `capture_started` | Recording-start callback; native capture uses its recording-start timestamp. |
| `capture_interrupted` | Recording interruption, background-triggered stop, or interrupted capture result. |
| `capture_saved` | Successful completion of original-media persistence. Failed persistence produces no saved event. Optional measurement never delays original-media persistence. |
| `submission_authorized` | The user's submit decision has been successfully persisted with the recoverable capture. |
| `upload_state_changed` | Persisted material recovery states: queued, uploading, waiting, retrying, committing, finalizing, complete or needs attention. Progress percentages are not emitted. |
| `help_opened`, `hint_dismissed` | Optional sample/help, deliberate replay and capture-guidance controls. |
| `recovery_action` | User-initiated saved-capture recovery. |
| `auth_started`, `auth_failed`, `auth_completed` | Previously consented reauthentication, fenced to the original account. |

Lifecycle events use the durable study journal's once-per-attempt deduplication. Upload-state repetition is suppressed across native runtime recovery. Transport retries preserve event UUIDs. Ending a task creates a new identity for the next task; suspending the runtime preserves unfinished work. Study storage or transport failures do not prevent the requested product action.

Clients do not emit authoritative `evidence_committed` or `proof_finalized` outcomes. Those outcomes and activation eligibility belong to the backend's canonical records and report.

## Automated evidence

- `npm run typecheck` in `mobile`: passed.
- `npm run test:study-timing`: 28 passed, including 8 new native trigger/runtime tests, 7 native study tests, and 13 shared bridge tests. The final auth-transfer test covers a restart after an interrupted buffer transfer and verifies stable task identity.
- `npm run test:recovery`: 29 passed, including the real completion coordinator with native I/O replaced at its boundary.
- `npm run test:first-proof`: 29 passed.
- The new trigger tests exercise deferred measurement, no-consent silence, actual-ready callback semantics, persistence failure, durable task identity after process recovery, account isolation, previous-consent reauthentication and withdrawal.

`npx expo export --platform android --platform ios --output-dir dist-measurement` passed for both platforms. After the authentication-transfer fix in `5bf0471`, a fresh `dist-measurement-final` export also passed, producing Android bundle `index-77672fc330816638c6682726946ecb98.hbc` and iOS bundle `index-8ea41a52c5a9e4d4d9e0a0e97c4e8cdd.hbc`. The generated files were preserved outside the checkout under `work/measurement-native-export-5bf0471`. The exports include the read-only sample asset. Metro reported the existing `@noble/hashes/crypto.js` fallback warning; export completed successfully.

A fresh signed application build is still required to distribute these changes. Physical-device runs must still validate permission denial, camera interruption, termination/relaunch, offline recovery and timing on the intended devices. Existing signed binaries do not contain this measurement code merely because source and JavaScript exports pass.
