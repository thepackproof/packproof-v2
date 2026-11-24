# Hosted order workspace rollout

The customer-facing portal and API use AWS resources whose names contain `staging`. They serve production. Prepare the release from the exact reviewed source and retain the currently served portal for rollback.

The **Prepare Connect live release** workflow selects the packet profile from the migration inventory. For a recovery packet, follow the [coordinated recovery procedure](../../infra/backend-release/CONNECT_RECOVERY_ROLLOUT.md). The image and upgrade sequence below applies to the legacy bridge from migration 122 to 124.

## Prepare the release packet

To reproduce the packet from a clean checkout with Node 24 and Python 3:

```sh
npm ci --prefix mobile --ignore-scripts --no-audit
npm ci --prefix web --no-audit
SOURCE=$(git rev-parse HEAD)
node infra/connect-rollout/prepare.mjs prepare ../connect-release/candidate "$SOURCE"
node infra/connect-rollout/prepare.mjs verify ../connect-release/candidate "$SOURCE"
node infra/connect-portal-release.mjs snapshot ../connect-release/previous-portal
```

Keep the previous portal directory intact, including the dotfiles. The live bucket is unversioned. Before cutover, verify that its public bytes still match the captured release:

```sh
node infra/connect-portal-release.mjs verify ../connect-release/previous-portal
```

## Prepare backend images

The compatibility image keeps the current API and worker usable when migrations 123 and 124 have been applied. The application image supplies the new order workspace. Both requests in the packet use exact Git bytes and the same migration inventory as the release.

The existing ECR repository retains its newest ten images. At initial preparation it already held ten, and an older worker task definition referenced an image next in line for expiration. Preserve that recovery option before publishing the two new images to ECR. Use private image staging for preparation. When publishing, verify ECR capacity against the current image inventory and maintain approved recovery digests. Record the resulting registry digests. A successful image build does not switch either service.

On an operator host with boto3 and normal AWS credentials, the following commands stage both images in encrypted S3 storage and retain their build receipts. Rerun the staging command with the same state directory to resume. The private S3 upload authority expires and is bound to one object.

```sh
python3 infra/connect-rollout/stage-private.py ../connect-release/candidate ../connect-release/image-receipts
node infra/connect-rollout/publish-staged-images.mjs check "$SOURCE" ../connect-release/image-receipts
```

At ECR promotion, use `publish` in place of `check`. It publishes the verified image bytes from staging and returns the registry digests to enter in the backend release review. Preserve the receipts with the release packet.

## Upgrade and open the workspace

1. Read both running task identities and the database migration ledger. The last hosted owner receipt ended at 122. Confirm the current database recovery point and private role bindings. Run the owner inspection with the exact candidate image. Record the API image, worker image, task revisions and existing feature-switch value.
2. Qualify and promote the compatibility image on **both** services, worker first. Wait for stable tasks and for the public API identity to match. An older running task could otherwise reject the upgraded database.
3. Run the candidate owner's transactional rehearsal against the observed ledger. Review its receipt and apply using the same review and successful rehearsal. The owner adds only the outstanding migrations. It preserves earlier Proofs, immutable originals, grants and revisions. Obtain independent API and worker readback at 124.
4. Qualify the candidate with the workspace switch closed. Promote the worker, verify its tasks, then promote the API and verify its public identity.
5. Publish the portal using the verified predecessor and candidate directories. The publisher compares the running API commit, installs assets before replacing the entry point, invalidates CloudFront and verifies the served files.
6. Enable `PACKPROOF_ORDER_WORKSPACE_ENABLED` with the coordinated workspace-switch operation. It checks the two running services and the portal identity.

See the [hosted backend rollout](../../infra/backend-release/connect-hosted-rollout.md) for commands, private review documents and AWS request constructors.

```sh
node infra/connect-portal-release.mjs promote ../connect-release/previous-portal ../connect-release/candidate/portal
node infra/connect-portal-release.mjs verify ../connect-release/candidate/portal
```

To compare a local Proof export with its hosted revision, supply the selected organization, environment and Proof ID. Set `PACKPROOF_OPERATOR_TOKEN` to a short-lived operator token authorized for that organization. The checker verifies each exported file hash and reports the source commit and revision.

```sh
node infra/connect-rollout/check-order.mjs "$SOURCE" "$ORGANIZATION_ID" "$ENVIRONMENT" "$PROOF_ID" "$OUTPUT_FOLDER"
```

## Recovery

Close the workspace switch before restricting new activity. Preserve existing grants, stored originals and committed database history. If the portal needs reversal, restore the captured release using the same origin:

```sh
node infra/connect-portal-release.mjs rollback ../connect-release/candidate/portal ../connect-release/previous-portal
```

For backend recovery after database migration, use the qualified compatibility image and reconcile work accepted since cutover. A pre-upgrade task definition alone is insufficient. Restore a database recovery point into a separate instance for investigation.
