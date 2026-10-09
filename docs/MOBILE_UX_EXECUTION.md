# Mobile experience execution

Source plan: PackProof_Mobile_UX_Development_Plan_Astra.docx supplied October 9, 2026. Base: origin/main at 195bf920ce77249631702ad5f48dc51e52ed019a. Branch: feature/mobile-task-first-ux. The starting checkout was clean. No production deployment or store submission is part of this work.

## Inventory before implementation

The current project is C:\src\PackProofV2. The legacy repository named in older memory is absent and is not the implementation target. V2 uses PostgreSQL server state, Expo native clients, and a separate React browser client. The domain has explicit server presentation, permission and workflow decisions. Native and browser screens are separate; selected copy and capture modules are shared. Native global typography and desktop layouts must not be changed to achieve mobile composition.

Native Root owns routes; Provider owns account scoped session, Proof cache, workspace source list, local recording journals, retries and foreground reconciliation. Home currently exposes a static station card; Activity is not a native destination. Scan is redirected to creation, despite an existing matching screen. Proof list action routing currently uses a stale list action after fetching a newer Proof. These are implementation gaps, not missing server capabilities.

Capture journals precede native recording, completed-file markers gate review, explicit attestation precedes durable handoff, and retries retain exact evidence identity. Upload, commitment, durable preservation and finalization are distinct. Existing retry/retention coordinators remain authoritative. Account scoped cache has no freshness timestamp; add a backwards compatible timestamp and invalidate freshness on failure. No media or draft migration is required.

Rollback uses a mobile composition build flag. It must only select layouts/routes, leaving capture storage, account ownership and upload workers intact. Manual creation already has no integration prerequisite. Provider catalogs determine actual connectable integrations at runtime.

## Validation boundaries

No Android device was attached at inventory time. Device interruption, storage exhaustion, biometrics, TalkBack and physical display acceptance require device evidence. Automated tests, browser renders and builds cannot establish those outcomes. macOS/Xcode availability and remote internal build credentials will be checked before claiming native binary or supported iOS validation.
