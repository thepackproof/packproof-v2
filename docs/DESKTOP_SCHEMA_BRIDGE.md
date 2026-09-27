# Desktop schema bridge and deployment sequence

This branch is based on verified live API source `2328447752af822538f901b57688628c2c08dfbe` (Shopify fulfillment). Its API behavior remains unchanged. Its migration inventory stops at `073_client_version_activity`. Only the startup schema checker changes: it also permits optional migration `074_desktop_capture_registration` with SHA-256 `3d598d733ab8aaf375fc793446b2ed732b42c2bcb9c47fc732af57c9eade692a`.

The migration SQL under `backend/tests/fixtures` is a checksum-pinned test fixture, not an executable runtime migration. This bridge cannot apply 074. Missing or changed baseline migrations, unverified or changed 074, and other future migration IDs still prevent startup.

## Rollout

1. Record current ECS image digest, service configuration and exact applied schema checksums. Build and pin the bridge image from this branch. Preserve every runtime setting and secret reference.
2. Deploy the bridge before applying 074. Wait until all API tasks use the bridge, verify health and `/meta`, exercise a normal capture, and verify schema still ends at 073. Keep desktop releases and registration unavailable.
3. Apply the exact 074 migration once using the reviewed migration task/role, transaction, advisory migration lock and recorded checksum. The old runtime remains operational because the schema changes are additive and its checker permits these exact bytes. Confirm the ledger and bridge health; do not down-migrate or delete evidence.
4. Deploy the desktop-aware candidate built on the verified live baseline with migrations through 074. Verify `/meta`, capabilities, existing Shopify behavior and authenticated desktop capture on restricted pilot accounts. Enable distribution only after the application acceptance gates pass.

## Rollback boundaries

Before any desktop capture registration has succeeded, the bridge is a compatible rollback image on either schema 073 or 074. Verify that `SELECT COUNT(*) FROM capture_sessions WHERE client='DESKTOP_CAMERA'` is zero before rolling back to its old runtime. Leave additive migration 074 in place.

After desktop capture records exist, the old runtime is not an acceptable general rollback target: its readers do not express desktop post-capture provenance correctly. Retain a separately reviewed desktop-aware fallback that understands these records and disables new desktop capture admission. Roll back to that image instead; preserve existing evidence, attestations and finalized manifests. This bridge alone does not provide that post-activation fallback.

Never roll back to unmodified live source 2328447 after migration 074: its schema check rejects the new ledger entry. Never loosen the checker to accept arbitrary future migrations or unknown checksums.
