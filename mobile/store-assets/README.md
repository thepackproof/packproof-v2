# Native UI review capture

This isolated simulator entry point renders the actual production screen components with fictional shipment records, an empty fulfillment queue, and a sample provider catalog. It does not change their layouts, access production accounts, issue shipment API requests, or start a camera. Every image includes a small `DESIGN REVIEW · SAMPLE DATA` label. These images are review references, not publication-ready store assets or evidence of a production rollout. The normal App.tsx entry point is untouched in the signed release job.

Run only in a disposable checkout: `PACKPROOF_STORE_SCREENSHOTS=1 node store-assets/prepare.cjs`, compile the iOS simulator Release app, then run `bash store-assets/capture.sh /path/to/PackProof.app`.

The capture script saves 13 opaque JPEG screenshots directly from an Apple 6.9-inch iPhone simulator:

- The original five scenes: Proofs in light and dark appearance, New Proof, shipment tracking, and Proof activity.
- Workspace Home in light and dark appearance, showing three Proofs needing attention and two completed Proofs.
- Orders in light and dark appearance, with the empty synchronized-order queue.
- Packing Station in light and dark appearance, at shipment selection before camera entry.
- Integrations in light and dark appearance, using fictional availability and no connected accounts.

`scene-manifest.tsv` records each filename, scene and appearance. The harness waits for theme hydration and layout to settle, reports render errors, and the capture script rejects missing or repeated images. Inspect every image after capture: these checks do not establish visual correctness. Tracking records, names, order references, amounts, and provider availability are illustrative sample data. No camera, biometric, upload or server behavior is asserted by these screenshots; physical-device and backend acceptance remain separate.

The workflow can reuse the pinned successful simulator binary only while its native configuration, dependencies, assets, plugins, and modules exactly match. It rebundles current JavaScript screen code and uses a simulator-local scene file, avoiding iOS external-link confirmation dialogs. Screenshot and signed-build jobs have separate queues and can be selected independently through workflow_dispatch.

For UI review, dispatch the existing workflow with `screenshots=true` and `signed_build=false`. This captures simulator images without building or publishing a signed release. Android uses the same React Native screen and theme sources, but these iOS captures are not Android rendering verification.
