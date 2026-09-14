# PackProof evidence record — Android 0.3.17 (46)

Implements the September 11 evidence-record brief on the existing build 45 baseline. Cards use authorized recording thumbnails, editorial titles, a fine record rule, distinct references and separate packing/shipment facts. The recording leads the detail screen; order context is expandable. Highlights contain actual transaction milestones, while detailed history retains technical events. Only finalized packing records use the “Packing record sealed” seal. Existing cinematic transitions and reduced-motion handling remain in place.

Sharing keeps its privacy notice visible and puts secondary explanation in a disclosure. The shared record and approved HTML case packet use the same record vocabulary. Packet limitations remain readable at a smaller size.

Tracking accepts a carrier number or supported USPS, UPS, FedEx or DHL link, including Android share intake. Connected fulfillment numbers are scheduled automatically. A later association records its actor and source in a new immutable row; it does not rewrite transaction shipping or the sealed manifest. Conflicting numbers or carriers return an explicit conflict. The three states are number saved, live registration confirmed and carrier events received. Registration and event retrieval use the existing bounded carrier worker and secret references.

Notifications have master/category switches, individual Proof mutes and persisted history. An allowlist projects confirmed user events; internal capture diagnostics do not produce alerts. The delivery queue deduplicates source IDs, retries temporary errors, checks Expo delivery receipts, and opens the authorized affected Proof. Device settings reflect Android permission and token registration. Local upload completion obeys preferences; remote registration suppresses duplicate local completion alerts. Android's required foreground transfer notification remains while a transfer runs.

## Figma handoff — blocked

Target: https://www.figma.com/design/DJb0KHM720CgjbdJkKGtHr

The Figma MCP connection hit its Starter-plan quota before edits could be applied. No Figma changes are claimed. Resume in the existing file after access is restored:

| Existing frame | Apply |
| --- | --- |
| Recording 1:3 | Compact serif identity, specific seal, recording before expandable context |
| Activity 1:34 | Human highlights; blue recording, violet attestation, teal carrier, green seal |
| Tracking 1:83 | Three progress states; Add/Connect/Retry tracking with source attribution |
| Upload 1:113 | Preserve upload behavior and foreground transfer visibility |
| Case summary 1:133 | Fine record rule, evidence-first hierarchy, smaller secondary limitations |
| Technical appendix 1:192 | Preserve full identifiers and integrity details |
| Design notes 1:221 | Document card, seal, timeline, notification categories, mutes and reduced motion |

Canonical implementation: mobile/src/ui/ProofRecord.tsx, mobile/src/screens/MyProofsScreen.tsx, mobile/src/copy/evidence-record.ts, mobile/src/notifications/, web/src/components/WorkspaceProofRecord.tsx, web/src/components/workspace-proof-record.css.

## Release requirements and limits

Apply forward migrations 063 and 064 using the existing separate migration authority before switching API traffic; preserve migration checksums and leave runtime auto-migration disabled. Preserve source signing, integration credentials and the existing Android upload certificate.

Remote Android push requires the application's Firebase google-services.json in the EAS GOOGLE_SERVICES_JSON file variable and an FCM V1 service credential configured in EAS. Never embed the FCM service credential in the app. Setup reference: https://docs.expo.dev/push-notifications/fcm-credentials/ . Token registration and push receipt acceptance do not prove delivery on a physical device. Device permission, background delivery and tap navigation still require a device check.

Focused validation: unchanged canonical manifest after later tracking, valid shipment supplement, association idempotency, conflict/authorization rejection, meaningful notifications only, history preservation under mute, push deduplication and release security. This release does not submit the bundle to Google Play.
