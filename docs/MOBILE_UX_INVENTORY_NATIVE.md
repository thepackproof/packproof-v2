# Native mobile UX inventory

Inspected 9 October 2026 against `195bf920ce77249631702ad5f48dc51e52ed019a`, before implementation. This is source evidence, not device or release evidence.

## Routes and ownership

`mobile/src/app/Root.tsx` selects native screens without a navigation-library stack. `PackProofProvider` owns route, selected Proof, current capture, account, lists, scroll restoration and the shared recovery coordinator. Home is `WorkspaceHomeScreen`; Proofs is `MyProofsScreen`; Orders and idle Packing Station use `WorkspaceOrdersScreen`. A restored legacy station recording uses `PackingStationScreen`. `NativeCaptureHost` remains mounted independently of normal screens. The existing `showsTabBar` always returns false. The workspace header exposes all destinations through a menu and repeats a breadcrumb.

`create` already renders the minimal manual creation form through `CreateScreen`. Integrations are optional. `go('scan')` currently redirects to creation despite the retained `ScanScreen`, so a new scan entrance must deliberately restore that route. Deep links support participant Proofs, history shares, order handoffs and native capture intents; they do not grant permissions. Back navigation records workspace origin; Proof and Orders lists retain their offsets.

## State, permissions and capture

Canonical Proof collections, record details, invitations, provider capability catalogs and fulfillment queues come from the API. The backend `proof-presentation` contract supplies action type, contribution permission, diagnostic state and completion; unknown states are not completed. Sellers ordinarily record fulfillment; buyers, receiver grants and grading workflow roles have different actions. `openOrder` reconciles current Proof and seller rights before choosing capture. Existing Proof-list action routing uses a pre-refresh action after fetching a fresh Proof and needs correction.

Local recordings are durable account/API-scoped journals. `savedRecordings`, `localCapture`, `uploadProgressByProof` and recovery phases distinguish local bytes, queued/transferring bytes, preservation, attestation, finalization and intervention. `resumeSavedCapture`, `discardSavedCapture` and `cleanUpSavedCapture` are the existing authoritative recovery entrances. Cleanup requires server preservation and finalization receipts. Sign-out saves recovery before clearing session and read caches; a new account must never inherit the previous account's records. Normal queued retries are passive and must not be ranked as user intervention merely because a retryable error exists.

The current default capture is one continuous video, review, explicit shipping attestation and authoritative completion. Legacy station rescans must not be restored to the ordinary path. Interrupted RECORDING journals are not assumed playable. No new offline creation queue exists; creation still requires a connection. Cached Proof rows are retained but the provider does not yet expose reconciliation freshness to Home, and `syncWorkspace` swallows network failures into its offline state.

## Secondary destinations

Account sections already retain billing, profile, notifications, integrations, uploads, appearance, support, privacy/deletion and developer access. Developer access is capability checked. Remote station remains an existing action. Recording rows currently live in Account and can be moved to Activity while continuing to invoke the same recovery operations. The provider catalog, rather than a hardcoded Shopify-only list, determines connectable services and order capabilities. Disabled providers should be collapsed without concealing existing connections needing repair.

## Desktop and rollback boundaries

Mobile web is the separate `web/` DOM app, not React Native screens. Web imports native pure `copy`, `theme` and `packing-station` modules through aliases and shares backend presentation contracts. Native composition changes can remain isolated; global token or shared copy changes require web regression. The planned `EXPO_PUBLIC_PACKPROOF_MOBILE_TASK_UX=false` build switch restores prior native composition while retaining the same session, media journals, queue, API and immutable Proofs.

## Validation available

Native TypeScript, API contracts, Proof navigation/list/scroll, upload handoff/recovery, capture identifiers, integration catalog and iOS configuration/parity tests exist. Web has Vitest and production build validation. These checks do not prove physical-device recovery, camera behavior, screen-reader focus, font scaling, keyboard/system-inset layouts or signed internal-build operation. Those gates require recorded device/build evidence separately.
