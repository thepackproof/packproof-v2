# Mobile web task experience: inventory and implementation evidence

Reviewed on 2026-10-09 against the PackProof V2 checkout, before editing. This is a client composition change; PostgreSQL Proof state, immutable evidence, manifests, server permissions, and the existing upload coordinator remain authoritative.

## Verified pre-change ownership

| Area | Existing owner / verified behavior |
| --- | --- |
| Routes and account | `web/src/App.tsx` parses workspace URLs and binds API token suppliers to the active user and API origin. Sign-out clears displayed data, not IndexedDB recordings. |
| Desktop | `AppNav`, `WorkstationHeader`, `HomeScreen`, `WorkstationProofTable`, and workstation styles own desktop navigation and layout. |
| Proof truth | `backend/src/domain/proof-presentation.ts` supplies neutral statuses, `canContribute`, diagnostic unknown-state handling, and role-specific next actions. A `FINALIZED` status without its timestamp is not complete. |
| Uploads | `web/src/capture-queue.ts` owns account/server-scoped IndexedDB files, stable upload identity, retries, byte integrity, commitment, and preservation. `LocalRecordingRecovery` runs the existing worker while the app is open. |
| Capture | `PackingStationScreen` records one continuous video; review, explicit declaration, shipping decisions, upload, and server finalization reuse the existing station machine and submission services. Camera barcode reading is an identifier, not evidence. |
| Recovery | Station journals and the browser capture engine restore the original recording; interrupted footage remains identified as interrupted. Local originals are retained until the existing preservation rules authorize removal. |
| Permission routes | Participant Proofs, receiver receipt links, invitations, developer tools, and admin access have distinct existing paths. No seller role is assumed for every viewer. |
| Connections | Runtime provider catalog controls enabled actions and capabilities. Shopify, eBay, and Etsy implementations exist; connected identity providers without transaction support do not supply orders. Runtime availability must be checked rather than inferred from source availability. |

## Implemented mobile route map

| Persistent destination | Route and responsibilities |
| --- | --- |
| Home | `/app`: deterministic shared selector, direct validated action, visible manual Create Proof, unique-record attention counts, active upload job count, waiting count, all-time finalized count, cached freshness and retry. |
| Proofs | `/proofs`: existing filter/query URLs and history restoration, compact records with next action, unknown status reconciliation, role-specific invitation/receipt routes. |
| Pack | `/pack`: camera barcode recognition using the existing decoder, manual reference entry and existing resolver, confirmation before association, existing Proof selection, manual creation with unknown reference prefilled, compact order queue. |
| Activity | `/activity` and legacy `/uploads`: account-scoped jobs grouped by intervention, progress, and completed events; retry joins the existing coordinator; distinct commitment/finalization labels; associated Proof and notifications. |
| Profile | Existing account, settings, integrations, orders, support, advanced/developer/remote station, sign-out, deletion and billing capabilities remain reachable. |
| Capture | `/proofs/:id/capture` retains existing coordinator. Mobile navigation is removed during recording and unsaved final-byte handoff; browser back is protected. `/station` remains compatible; remote pairing hashes and `/station?tools=1` preserve remote tools. |

## Evidence and reliability boundaries

- Home rendering does not mutate records, retry uploads, attest, or finalize. The existing recovery worker continues its prior background behavior.
- Recommendation taps re-read canonical Proof state, recheck the active account/server and source route after asynchronous work, and route using the latest authorized action. Already finalized records open their current record. Authorized receipt/return continuation does not reopen root capture.
- A saved recording receives review rank only after a bounded local video metadata/playback check, and interrupted recordings go to recovery. Failure to inspect media is conservative and does not claim usable capture.
- Scheduled automatic retries and healthy uploads remain passive. Multiple stopped jobs on one Proof do not multiply attention counts.
- Server-only actions are deferred offline. Existing scoped station recordings can enter local review; upload and authoritative submission still need the connection and existing server checks.
- Capture's earlier optimistic “saved” copy was corrected: durable acknowledgment now follows the successful IndexedDB transaction or recovery of the existing journal. A failed local save exposes retry, retains the in-memory original, blocks submission, and protects exit.
- Session-only aggregate UX event counters use the shared helper. They include no media, identities, tracking, addresses, tokens, network transport, or persistence. Existing optional research consent and timing transport are unchanged. No measured improvement is claimed.

## Responsive boundary and rollback

The mobile composition activates at the existing `760px` responsive boundary. Set `VITE_PACKPROOF_MOBILE_TASK_UX=false` and rebuild the web bundle to return to the existing workspace composition. The flag does not delete or migrate queued jobs, IndexedDB recordings, drafts, or server evidence. Existing desktop components and route capabilities are retained. `/pack` is registered in the public website's workspace route boundary so direct entry remains valid.

## Review fixtures and validation

Run `npm run review` in `web/` for the development-only local fixture server at `http://127.0.0.1:5180`. Its API responses are fictional and mutations cannot reach a live PackProof service. Use `/app`, `/pack`, `/proofs`, `/activity`, `/stores`, and `/account` at 360px, 412px, and desktop widths. Home fixtures: `?review-state=empty`, `completed`, `offline`, `large-text`, `error`, or `stale`. The stale fixture first loads then simulates a failed refresh. The large-text fixture increases displayed text for layout inspection; it does not substitute for a physical-device font scaling check.

Web regression suite passed 52 files / 292 tests plus 11 Node route/association checks at the first complete checkpoint. Additional follow-up coverage verifies finalized receipt continuation. Production Vite build and TypeScript passed; Vite reports the existing mixed static/dynamic identifier import warning and an application chunk over 500 kB. Final exact-revision results are recorded in the execution handoff.

Physical Android/iOS recovery, camera permission transitions, low storage, force-stop, live server finalization, real scanner/device decoding, screen readers, keyboard/gesture/system inset behavior remain separate release gates. Unit, browser fixture, and build evidence must not be described as passing those device or production gates. The web build was not deployed.
