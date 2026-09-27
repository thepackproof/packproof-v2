# Desktop-aware admission rollback

This candidate is based on `d45727b8648ade030642a011c280c10bce525591` and is
prepared for rollback after schema migration 074 or desktop evidence admission.
It is not the old pre-desktop server. Do not drop migration 074 or overwrite
desktop evidence provenance to make an older application appear compatible.

## Behavior

- `POST /proofs/:id/capture-sessions/desktop-registration` always returns
  authenticated HTTP 503, code `DESKTOP_CAPTURE_ADMISSION_PAUSED` and
  `Retry-After: 300`. It does not create sessions, reserve allowance or mutate the
  Proof. This includes idempotent registration retries.
- Capabilities explicitly advertise `registrationEnabled: false` and
  `admissionState: PAUSED`. The understood `registrationVersions: [1]` and
  `recoveryVersions: [1]` remain advertised so the existing desktop client can
  pass its protocol compatibility check when recovering a known session ID.
  Protocol comprehension is distinct from permission to admit new recordings.
- Recordings that have a persisted capture session ID retain the ordinary
  authenticated recovery, upload, commit, shipping review, attestation and
  finalization paths. Canonical views and manifests retain honest desktop
  client-reported provenance. Original media validation is unchanged.
- An original whose registration response was lost before the local client
  persisted the session ID will remain local while this rollback is active.
  Re-enabling registration restores its stable-idempotency replay path. Never
  discard that original or represent it as remotely committed.
- Existing web/native admission, historical evidence, frozen manifests and
  non-desktop workflows are unchanged.

No runtime environment switch silently re-enables desktop admission in this
candidate. Returning to an admission-enabled candidate is a separate deployment.
The domain registration function remains available for historical test fixtures;
the production HTTP route has no path to invoke it.

## Validation scope

Focused tests verify rejected admission with no session/reservation, blocked
replay and preserved known-session ownership/recovery, ordinary web/native
admission, and the actual unchanged desktop transport completing multipart
upload, hash/commit, attestation/finalization, evidence range reads and export for
an existing session. Schema/provenance regression tests remain in place.

Local verification: backend typecheck passed; 21 tests passed across
`desktop-safe-rollback`, `desktop-capture-registration`,
`desktop-client-contract`, and `capture-sessions-relay`. Dependencies were
installed from this candidate's exact lockfile. No source or dependency changes
were made in the main worktree.

This branch was prepared locally only. A commit or build does not mean it was
pushed, deployed or selected as the running service. Verify the image digest,
release identity, migration inventory and current live behavior before using it
for an operational rollback.
