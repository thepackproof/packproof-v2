# PackProof Connect 0.5.0 candidate

The Windows application supports setting up several source folders, reusing one location across stages, reviewing order records, and choosing a separate destination for local proof copies. Operators can reopen setup where they left it. Existing shipment connections remain accessible. The service and the operator application are distributed together under the existing channel-specific application identity.

## Install or upgrade

Use the single installer for the intended environment. Match its SHA-256 and source commit to the release evidence. Close the existing application and use the upgrade installer in place. Retain the existing organization, service identity, protected ProgramData folder and its keys. Use a separate staging operation and local output destination before widening a release. Source/profile scope changes require the authorization shown in the application.

The workflow produces one Start menu entry per installed channel. Development and production can coexist with separate names and data directories. A successful CI install or restart on hosted Windows Server does not establish Windows 11 reboot, customer environment or signed release qualification.

## Compatibility and recovery

Deploy the additive order workspace API and database schema, compatible web client and qualified source profiles before activating the Windows release. Keep prior single-source API support during the upgrade. Retain immutable originals, order revisions and output history.

If the approved API returns an incompatible response, pause new collection and leave retained jobs in place. If output is interrupted, restore access to the intended destination for the Windows service account. Use the application to select a separate destination when necessary. Existing completed revisions remain independently readable.

For retained Windows state recovery, stop the service through its supported lifecycle, obtain an operator-authorized protected backup of the complete channel data, including the SQLite database and any journal files, encrypted spool, protected state, and keys. Retain machine/identity protection and ACLs. Validate restoration on a representative isolated Windows system with the same DPAPI context. Copying these files to another PC does not transfer the machine's cryptographic context. Preserve the original backup until the existing source IDs, pending jobs and server-side order revisions have been reconciled.

The installer blocks binary downgrades. Preserve queues and accepted records on the current version. Use a forward recovery build that understands the newest persistent format, or the authorized prior compatible service configuration after explicit compatibility validation. Never roll the backend database back past committed revisions. Retain prior signed binaries and migration receipts, and prefer a forward correction for an erroneous association.

## Evidence

Use examples/multisource-journey/README.md for isolated fixture publication, receipt comparison and the manual release checks. The Windows candidate workflow records packaged renderer screenshots, native service setup/restart receipts, and build and checksum evidence. The hosted checks exercise restart and declared startup mode. Record observed reboot, signed installer, successful browser review, actual data-source freshness and independent desktop/web/local revision confirmation in the release ledger.
