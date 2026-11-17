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

## Isolated integration observation on November 17, 2026

Seven physical source directories fed the real Windows AgentRuntime over HTTP through a local named pipe. An isolated PackProof API performed enrollment, redeemed the service credential, accepted the operator's exact browser-session approval, and committed order revisions using its migrated test database and local original-object store. All customer data and live endpoints stayed outside the test operation.

An initial SO10482 revision appeared 6.901 seconds after order publication. Picking, two packages, carrier labels, handoff and delivery evidence reached that same proof. Detached evidence joined when a later package relationship arrived. The worker reopened its persisted state. During a local output outage the correction raised the line 20 ordered quantity to three, while the shipped quantity remained two. The human-facing endpoint showed the correction after 4.291 seconds. The previous completed copy remained readable throughout the interruption. After restoration, the independent verifier observed revision eight in 1.343 seconds, checked all 17 manifest files and matched the exported original ZPL label byte-for-byte. The desktop service feed and human-facing proof returned the same revision.

The observations are single-run timings. The fixture invokes the service command runtime under the test login, uses a test secret protector and exercises the browser approval HTTP endpoint programmatically. Hosted Windows CI builds the packaged application and runs the full native dependency set. Installed UI review, machine reboot and pilot data qualification remain independent gates.

## Windows service recovery

The source registry, source generations, approved scope and output writer live in the service-protected state. The queue uses SQLite WAL with synchronous FULL and encrypted spool files. The first setup migration also saves `pre-workspace-state.bin`. An activated workspace writes protected-state version 6. A 0.4.x service rejects that marker before opening the queue. Keep a matching or newer workspace-aware service for recovery. Draft-only legacy stores retain the earlier format.

1. Record the installed channel, service identity and executable version. Stop the channel's PackProof Connect service and confirm that its status is Stopped. Keep the current output writer offline throughout restoration.
2. Back up the complete channel directory under `%ProgramData%\PackProof\Connect`, including `state.bin`, `spool-key.bin`, SQLite and its WAL/SHM companions if present, the entire spool, media cache and service ownership/ACLs. Back up the destination's proof directories, writer marker and published revision pointers separately. A copy of the protected setup state alone cannot restore queued files.
3. Restore to an isolated destination first. Use the original Windows service identity and the required Windows encryption context. Verify the queue opens with its retained key, the installation ID and source generations match, and the expected output writer, feed cursor and previous published revisions still exist. Preserve the original copy until verification and administrative recovery are complete.
4. Start exactly one compatible service against the recovered data. Restore its approved input and output access, then confirm a stored observation obtains the same server receipt after retry. Check the current proof against the API revision and the hashes in its local manifest. Use an auditable new association or mapping revision to correct a record.
5. A full machine loss requires recovery of the Windows cryptographic context or the supported enrollment recovery process. Recoverable source files can be replayed after an explicitly approved new scope. Keep a record of unrecoverable intervals.

On an isolated Windows NTFS fixture, a one-original spool limit admitted the first report and left the second report available at its source. The test stopped and checkpointed the worker, backed up the complete protected store, restored it to a separate directory, and verified the queue digest, original, writer identity and cursor. It then resumed both reports and observed exactly two distinct accepted observations. One measured run took 75 ms from copying the backup to verifying restored state and 473 ms for the entire case. Zero captured observations were lost. This is a single-machine test with a test protector, two small files and no network outage or machine-key replacement. Enterprise restore time and cross-machine key recovery require an operations exercise.

## Source transport and authorization limits

| Source | Implemented collection | Qualification boundary |
| --- | --- | --- |
| Local Windows folder | Native service read with final handle, link and physical-directory checks, change notifications, bounded content reconciliation, versioned admission and durable replay | Selected folder only. Add subfolders explicitly. Up to 24 source connections, 10,000 directory entries and 2 MiB per individual file. File producers should use a completed-file handoff. |
| UNC share | Uses the service identity and UNC path, checks physical identity and retries reconciliation after access returns | Requires actual read/list permissions for that identity on both the share and its files. DFS, failover and site-specific share behavior need customer qualification. |
| PackProof Partner API | A scoped integration account submits orders, retains their initial Proof IDs, accepts explicit operation binding, and deduplicates replay. Cloud-created orders enter the same change feed as folder records. The approved computer retrieves applicable prior order snapshots in bounded pages. | History requires a single unambiguous direct-source binding and a matching merchant, account, operator and location. The original request body for an older import is unavailable. Its persisted transaction snapshot and hash are labeled derived. A paused API source is enforced by the server. |
| Vendor APIs, object/SFTP repositories and database change feeds | Existing product-specific flows retain their independent authentication. Their published exports can be connected through an approved source folder. | Dedicated direct SFTP, object-listing and database-change subscriptions are outside this candidate's implemented workspace transports. A generic parser, an existing unrelated vendor sign-in or a completed file upload does not establish vendor qualification. |

The bounded source preview samples up to six files. Folder collection reads new changes while the window is closed and checks content during reconciliation. A previously approved grant permits local capture for up to one hour after its last successful check. A confirmed denial takes effect immediately. Reopening enrollment or changing a source cannot silently transfer a captured original to a different source generation. The protected writer retains its last completed local package through an output outage. Persistent non-replayable losses at the producer and remote publication cadence still limit attainable coverage.
