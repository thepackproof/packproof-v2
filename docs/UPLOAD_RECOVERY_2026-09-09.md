# Upload recovery release — Android 0.3.14 (43)

The original recording and its upload identity are recoverable independently of the current screen. Account-scoped mobile journals and the browser IndexedDB queue retain the original until an authoritative commit/preservation response permits cleanup. A missing local file no longer clears its identity.

The Recording card exposes Resume upload and Discard recording. It distinguishes an active transfer, waiting for connection, interruption, failure, and a missing original. Missing originals offer Discard incomplete evidence. Committed evidence never offers incomplete-upload discard.

Retries reinitialize transport with the saved idempotency key and verify the returned evidence ID. Server reads recover lost commit responses. Connectivity events and application resume wake the persisted queue. An upload with no byte progress for 90 seconds becomes retryable; progress renews that idle deadline.

Discard persists its intent, serializes with uploads, closes the pending server evidence/session, and only then removes local bytes. Failed discard remains queued. The backend scopes identity-based discard to the Proof and submitting participant, locks its records, rejects committed evidence, and closes its capture session and admission. No schema migration is needed.

Validation: 67 focused tests passed (27 mobile, 23 browser, 17 backend), including lost responses, identity conflicts, missing bytes, restarted discard, committed-evidence protection, direct card actions, and upload inactivity/expired URL handling. Backend, mobile, and web TypeScript checks passed. Release build and deployment results are recorded separately.

Physical Android force-stop/reopen and connectivity-loss validation on the Galaxy S24 Ultra and A16 5G remains a device acceptance check; automated checks do not substitute for that exercise.
