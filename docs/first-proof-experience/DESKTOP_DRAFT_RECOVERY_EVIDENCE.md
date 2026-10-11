# Desktop manual creation recovery

The desktop creation form now saves its fields in local application storage using the configured API endpoint and authenticated user ID. The main process supplies that scope through a core Proof method; creation does not depend on study consent, telemetry availability, or the first-experience display flag.

Before the first request, the form saves a random operation identity and the exact normalized transaction request. A timeout, lost response, authentication failure or downstream error preserves them. Retrying sends the same transaction `idempotencyKey` to the existing backend contract. The backend reopens the canonical Proof for that transaction. If the user edits an uncertain request, the form blocks resubmission and offers **Recover submitted draft**, restoring the original fields without replacing its operation identity.

Closing and reopening the form restores the draft. A successful response clears it only after the application accepts the returned Proof for camera navigation. Storage failure prevents a request from being sent. Neither a made-up order reference nor a placeholder transaction ID is used.

The IPC boundary accepts a bounded optional operation key and optional expected user ID. The main process rejects a stale renderer owner before obtaining credentials or making a request; the existing transport continues to fence account changes during network work. Transaction metadata, Proof IDs and arbitrary fields remain excluded by the strict IPC schema. Legacy IPC callers remain compatible.

## Evidence on 2026-10-11

- Desktop typecheck passed.
- Full desktop suite passed: 105 tests across 14 files.
- Desktop production source build passed.
- Seven new tests cover response loss through the real desktop API/IPC schema, exact request recovery after edits, account/API scope isolation, storage failure, corrupt operation state, stale renderer owner, strict payload validation, and disabled creation before scope verification.

These are source, model and build checks. They do not claim that a signed installer has been produced, that an installed application was exercised, or that physical-device acceptance and publication have occurred. The new renderer, preload and main-process changes require a fresh desktop application build for distribution.
