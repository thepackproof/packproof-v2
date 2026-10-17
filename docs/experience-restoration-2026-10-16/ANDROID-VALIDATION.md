# Required Android demonstrations

Status October 17: **not executed on a device**. Use the exact PR-head receipt and a clean spare Android device/emulator with no production media. The internal artifact uses debug signing, package `com.packproof.mobile`, version 1.0.1 / 66; it does not upgrade a differently signed Play install. Do not uninstall production or clear its media.

Use designated test accounts/Proofs. Record device/OS, source/APK SHA-256, account role (no secrets), Proof/capture/evidence/action identities, observed UI and authoritative receipts. Compare original hashes before/after interruptions. Browser samples do not satisfy these rows.

| ID | Demonstration | Required result |
| --- | --- | --- |
| R1 | Ordinary continuous packing: stop, Back, Home, reopen | Same local original/session/hash remains playable. No reset or implicit replacement. Explicit retake binds the selected take. |
| R2 | Interrupt via background, permission change, incoming call and process termination | Surviving media discoverable and inspectable if decodable. Interrupted media cannot be accepted as continuous evidence. Keep/recovery and deliberate discard available; missing bytes remain an honest failure. |
| R3 | Queue recording then request retake/open another Proof | Submitted identity cannot be replaced or consumed by another Proof. Discard retains the existing server cleanup protocol. |
| P1 | Actual grading front/back recipe, Save once | Real file commits and item-action acknowledgment lead automatically to the recording task. No manual event control. |
| P2 | Lose commit response, terminate, reopen | Same upload/evidence identities; reconcile receipts without duplicate committed artifacts or retransmission of acknowledged bytes. |
| P3 | Lose item-action response after backend advances, terminate, reopen | Replay original action key, preserve original hashes, reconcile exact item/Proof, show next task. |
| P4 | Stall upload/API, go offline, reconnect | Bounded timeout, at most three automatic attempts, then actionable Check state. Reopening resumes intent. Pending evidence is never called complete. |
| P5 | Retake accepted local photo; race retake with Save | New file/key, prior original retained. Submission lock prevents replacement or stale receipt application. |
| P6 | Switch account/API or select B while A responds | No cross-account write/disclosure; A never replaces B. Reopening A reconciles A only. |
| E1 | Bytes complete, commit pending, finalization pending, then server confirmation | Truthful distinct states; verify original hash/manifest/durability. Completed copy follows authoritative success. |
| E2 | Notification/deep links and evidence tools | Exact Proof/account; originals, History, Shipment, Order details, share/export/retention remain reachable. |
| V1 | First and returning Home, 3+ incomplete Proofs and invitation | One accurate recommended action, item titles, separate incoming work and participant work. |
| V2 | Light/dark, 100/130/200% text, TalkBack, reduced motion, low-end device | No clipped primary actions/tabs; logical focus and announcements. Motion ceases when reduced. No recording haptic interference. |
| C1 | Old/new binary draft/queue/committed/shared/expired matrix | Original hashes, identities and permissions preserved; queued work recoverable; rollback does not delete originals. |

Record observed results and linked device evidence for every row. Retention, identity, false-success, account-isolation and accessibility failures block release. Then execute five-person formative findings before broader propagation, ten fresh-user acceptance, and named-build G4 review.
