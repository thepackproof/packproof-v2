# Mobile intake implementation and release

This change implements the core of the September 15 mobile intake plan on the reconciled Android 49 and iOS parity source. It adds a shared submission boundary to the existing intake, transaction, Proof, and capture services. Desktop extensions, OCR, new marketplaces, and camera segmentation remain outside this release.

## Work package map

| Package | Implementation |
| --- | --- |
| WP0 baseline | INTAKE_DEPLOYMENT_CONTEXT.md and INTAKE_SOURCE_SUPPORT.md |
| WP1 submission contract | backend/src/intake/submissions-contract.ts, submissions.ts, sessions.ts; existing intake router; migration 067 |
| WP2 commerce | existing commerce worker, fulfillment sync, eBay and Shopify adapters; migration 068; INTAKE_COMMERCE_SYNC.md |
| WP3 Android | existing with-order-share plugin; packproof-order-share Android module and WorkManager |
| WP4 shared client | mobile/src/intake, native session management, existing root routing and ready queue |
| WP5 and WP6 iOS | existing host and Share Extension; protected shared outbox and restricted Keychain session; INTAKE_IOS_RELEASE.md |
| WP7 links and release | owned domain association generator, web authenticated intake and fallback; existing EAS profiles and release workflows; INTAKE_OWNED_LINKS.md |
| WP8 qualification | release evidence records and automated checks; physical device, store distribution and live-provider checks remain separate gates |

## Deployment order

1. Record the current API and worker images, configuration, migration set and recovery position. Preserve the current developer allowlist, authentication, signing, evidence storage and recovery settings.
2. Build the API image from the exact candidate. Run the existing controlled migration entry point (`npm run migrate:prod`) with the configured migration role and credential reference. Do not reset data or adopt mismatched checksums.
3. Deploy the same image to the API and existing worker. Keep new intake admission and provider automation off until the relevant release gates pass. Confirm the `mobile-intake` worker heartbeat and queue/lease behavior; a health response alone does not qualify the worker.
4. Publish the matching web build and association files. Check association JSON directly on both owned hostnames without redirects or SPA fallback. Do not publish an invented Apple application identifier.
5. Build Android using `shipping-integration` and EAS CLI 24.4.2, preserving `com.packproof.mobile` and its existing upload key. Candidate version 0.3.21/code 50 advances the verified Play code 49 baseline. Increase it if any higher version has since been uploaded.
6. Compile iOS app and embedded extension with Xcode 26 or newer. Existing Apple signing authorization and credentials are required for a device archive; a simulator build does not satisfy TestFlight delivery.
7. Qualify the signed platform with an actual supported share, account/offline recovery, verified link and complete existing evidence flow. Enable internal actor IDs and only independently verified providers. Do not represent synthetic fixtures as a live marketplace read.

## Rollback

Disable new admission with `PACKPROOF_INTAKE_ENABLED=false` and new automatic marketplace work with an empty `PACKPROOF_COMMERCE_AUTOMATION_PROVIDERS`. Retain the installed schema, Proof reads, committed evidence, and existing upload recovery. These flags must be applied consistently to API and worker.

The existing runtime requires the exact migration inventory. After migrations 067/068, simply restarting a pre-intake image can fail its schema check. Use configuration rollback on this schema-compatible release, or a separately verified image that carries the same additive migration inventory. Never drop the new tables as a rollback shortcut.

## Verification economy

The release reuses the existing backend suite and mobile API, Proof-record, recovery, build-security and iOS gates. New parameterized checks cover intake identity, authorization, resolution, worker failure, native persistence, account assignment and safe links. There is no provider-by-device end-to-end matrix, unrelated screenshot sweep, camera rewrite, or new soak test. Failed checks are rerun only at their affected boundary.

## Delivery status

The source and automated implementation are reviewable. Store artifacts, exact candidate SHA, deployment IDs, checksums, enabled provider capabilities and remaining gates are recorded in the final handoff. A compiled app is not a physical-device test; a built artifact is not a processed store release.
