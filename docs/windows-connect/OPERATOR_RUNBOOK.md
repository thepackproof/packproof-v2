# PackProof Connect operator runbook

Release scope: Windows 11 x64; one direct merchant organization/environment/source; one dedicated local NTFS folder; immutable UTF-8 CSV exports. General availability and customer qualification require the gate evidence in `IMPLEMENTATION_STATUS.md` and `EVIDENCE.json`.

## Before setup

1. Select the always-on collection PC and responsible source owner. Sleep, shutdown and loss of network can delay collection. Install once for this source.
2. Arrange Windows administrator assistance for the per-machine install. The business user finishes approval in their own browser session.
3. Have the source producer write a temporary file, close it and rename it to a unique final `.csv`. Final exports are immutable. Retain originals for the agreed recovery period (pilot starting point: seven days).
4. Use one local NTFS folder, not a mapped drive, network share, cloud placeholder, system folder or recursive tree. Confirm the actual LocalService service identity can read it. Do not broadly rewrite folder permissions.
5. Prepare an active PackProof merchant workspace with an eligible OWNER/ADMIN, authorized source account, location and responsible operator. Enrollment initially permits setup only.
6. Use exports within the smaller client/server limits: initially 2 MiB, 1,000 rows, 50 columns and 10,000 characters per cell. A stable shipment reference, description, integer quantity and explicit time zone are required. Preserve leading zeros. Cartons or fractional units require a compatible export or assisted adapter.

## First import and activation

Compare the installation code in PackProof with the local application. Review the exact organization, environment, source, location, operator and permissions. Do not approve an unexpected installation.

Local sample preview stays on the PC. A cloud preview uploads and preserves the entire original CSV, including unmapped columns. Re-export approved columns at the source before upload if necessary. Prefer a one-row authorized export for setup. A larger batch requires explicit approval for every displayed row; the existing API commits the batch.

Approve the exact configuration and first-import policy in the browser. Wait for terminal row outcomes and retrieve at least one accepted record. An upload or queued response is insufficient. Then approve recurring collection for the same verified configuration. Changing the source, mapping, time zone, operator, location or original invalidates the previous verification.

## Read health correctly

Review service online, last folder scan, last observed export and last completed server import separately. An empty folder and running service mean source freshness is unknown unless an expected export schedule was explicitly configured. Check upstream export scheduling separately from PackProof connectivity.

Pause stops new reads and submissions. Already accepted server work may finish. Revocation prevents new authorized server work; an offline PC learns remote policy only when it reconnects. New offline reads stop after the approved cached policy window (at most 24 hours), or immediately on clock uncertainty. Existing staged work remains preserved.

## Recover without duplicating work

- Network timeout: keep the same queued operation, request body and idempotency key. Refresh its receipt before declaring failure or retrying commit. Do not create a new import solely because a reply was lost.
- Invalid or ambiguous rows: inspect every row outcome and correct the export/mapping through an approved new revision. Do not silently guess units or dates.
- Changed shipment reference content: preserve and review the conflict. Do not overwrite the earlier assertion.
- Disk/quota pressure: pause admission, retain pending originals and increase an approved budget or reduce export volume. Do not delete the oldest pending files.
- Credential expiry/revocation: require browser recovery. A new credential does not automatically own old receipts. Drain accepted imports under the old token before routine renewal.
- Machine replacement: revoke/pause the former installation, enroll the new PC and explicitly replay retained originals under the same source namespace. Permanent backend source bindings prevent duplicate shipments; conflicts still need review.
- Protected storage or SQLite failure: stop and preserve queue, database, WAL and encryption key. Do not fall back to plaintext or create an empty replacement queue.

## Updates, repair and uninstall

Use the channel's signed installer and verify the expected publisher. A missing or wrong signature blocks release and upgrade. Do not disable Windows protection to install a package.

Before upgrade, pause admission and checkpoint the queue, then stop the service. Preserve the existing encrypted data and keys. Reject a downgrade that cannot read the current schema. Repair restores binaries, service registration and expected ACLs without resetting enrollment or pending work. The approved local Windows operator is retained in protected machine metadata; a different administrator session does not silently replace that operator. An explicit IT operator-SID override is separate from cloud administrator approval.

If a shared ProgramData ancestor has an untrusted owner or ordinary-user replacement rights, setup stops before protected storage is used. Have IT review the exact dedicated ancestry and preserve any existing Desktop/source permissions. Do not recursively rewrite shared data ACLs or move the encrypted queue as a shortcut.

Disconnect/revoke in the authenticated portal before uninstall when possible. Offline uninstall cannot claim cloud revocation. Uninstall removes the service/UI and retains encrypted queued work and keys by default; it never deletes source exports, cloud records or PackProof Desktop evidence. Any cleanup of uncertain evidence needs explicit reconciliation or an informed recorded discard under the applicable policy.

## Diagnostics and release evidence

Preview the diagnostic bundle before sharing it. It may include versions, safe installation/configuration IDs, queue counts, timestamps, error/request/receipt IDs. It excludes bearer values, enrollment secrets, customer rows, full source paths and signed storage URLs. Sharing is an explicit user action.

Before publishing, record exact commit, artifact names and SHA-256 hashes, API/portal/binary versions, T01–T25 outcomes, signed publisher, supported exporter/version/owner and the pilot observation period. Record exact novice results and setup times; five observations do not establish population percentiles. Name the actual support and deployment owners in the customer handoff.
