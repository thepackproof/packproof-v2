# Shipment automation candidate preflight

Use the `reconstruction-v7` archive for the automation candidate. The November 16 image-only rollout and reconstruction v6 retain their historical migration inventories. The v7 review covers exactly 120 applied migrations ending at `121_shipment_interpretation_decisions`. Its full inventory SHA-256 is `3a0d0f641856846529659e12eb7ba166f8542753b663b4d5ab903862ee905de5`.

1. Obtain the immutable candidate image and exact Git source from the verified build. Measure its compiled policy files in an isolated copy of the reviewed image. The manifest command uses the image’s own built modules.

   ```sh
   node /release/shipment-automation-pair.mjs manifest /app/backend/dist
   ```

2. Create a new private `packproof.reconstruction-release-review/v7` using the existing reconstruction target, image, distinct runtime roles, records migration hash, source, expiry and review fields. Pin the manifest’s `bundleSha256`, `interpretationVersion` and `headerPolicyVersion` inside `automationPolicy`. Add the independently reviewed API settings `interpretationEnabled`, `headerVariantsEnabled` and `shadowSourcesSha256`. Both enabled values are booleans. For observation-only qualification, set both to false. The shadow hash is SHA-256 over the compact JSON string for the sorted list of approved `installationId:configurationRevision` strings, or the JSON string `[]` when observation is off. Maintain `featureActivation: false` and `customerReleaseQualified: false` on the review.

3. For each role in the isolated environment, provide `PACKPROOF_RECONSTRUCTION_V7_REVIEW_JSON`, the SHA-256 of that exact compact JSON in `PACKPROOF_RECONSTRUCTION_V7_REVIEW_SHA256`, and matching `PACKPROOF_RELEASE_SHA` and `PACKPROOF_RELEASE_IMAGE`. Use the actual API login for one candidate task and the actual worker login for the other. Run each task’s preflight under its reviewed runtime configuration and record the complete JSON result from the successful task.

   ```sh
   node /release/reconstruction-v7-runtime-preflight.mjs api
   node /release/reconstruction-v7-runtime-preflight.mjs worker
   ```

4. Compare the two original reports within 15 minutes. The check binds their ECS identities, source/image, applied migration inventory, immutable decision trigger, effective privilege reports and built policy hashes to the same review. If previewing a proposed activation, both roles must declare the worker marker for each enabled policy: `PACKPROOF_SHIPMENT_WORKER_INTERPRETATION=packproof.shipment-interpretation/v1` or `PACKPROOF_CSV_HEADER_WORKER_POLICY=same_names_any_order/v1`. The worker must carry the measured implementation of that same version. Keep the paired output beside the complete reports and the corresponding cloud task identities.

   ```sh
   node infra/backend-release/shipment-automation-pair.mjs private-review.json api-report.json worker-report.json
   ```

These commands perform read-only measurements. Subsequent rollout still requires the plan’s installed first/next-export, restart and revocation evidence, named source-owner approval, and explicit release authorization. Switching off new admission or shadow observation preserves already admitted receipts and originals. Use a compatible reader for retained work.
