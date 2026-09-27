# Live staging desktop API acceptance

This checks the actual deployed API using `AuthService`, `DesktopApi` and
`DesktopEvidenceTransport`. It is separate from the mocked renderer and local
PGlite tests. It creates two clearly marked synthetic Proofs from the checked-in
MP4 and streaming WebM fixtures. It does not exercise a physical camera or
certify a native installer.

## Prepare the deployment and isolated account

1. Apply and verify the reviewed desktop migration, deploy the exact candidate,
   and obtain its real `/meta` commit and `/capabilities` response.
2. Record the verified migration inventory in a local JSON receipt:

   ```json
   {
     "environment": "staging",
     "apiBaseUrl": "https://YOUR-STAGING-API",
     "sourceCommit": "40-character-exact-deployed-source-commit",
     "verifiedAt": "actual-recent-verification-time-in-ISO-format",
     "migrations": [
       {
         "name": "074_desktop_capture_registration",
         "sha256": "actual-SHA256-from-the-applied-SQL-and-local-source",
         "applied": true
       }
     ]
   }
   ```

   The script checks the source commit, API environment, local SQL checksum and
   a receipt age under 24 hours. It never migrates or changes a database directly.

3. Create a dedicated Cognito account named
   `desktop-staging-<unique-run-id>@example.invalid`. Use `AdminCreateUser` with
   `MessageAction=SUPPRESS`; set its password permanently through the normal
   Cognito administrative operation. Do not send email. Do not use a real
   customer account. No login secret is written into the repository or report.
4. Leave the account unenrolled. Existing server policy permits new accounts
   with no offer period to use the ordinary pilot capture workflow. The script
   verifies no existing Proofs, active priced offer, subscription, pending
   checkout or automatic charging before creating synthetic records. If server
   policy denies capture, stop and preserve the failure report; do not grant
   test credits, adjust billing, or disable enforcement to force a pass.

## Environment inputs

Provide through the execution environment, not command-line arguments:

- `APP_ENV=staging`
- `PACKPROOF_API_BASE_URL`
- `PACKPROOF_COGNITO_REGION`, `PACKPROOF_COGNITO_CLIENT_ID`,
  `PACKPROOF_COGNITO_USER_POOL_ID`
- `PACKPROOF_SMOKE_EXPECTED_COMMIT`
- `PACKPROOF_SMOKE_MIGRATION_RECEIPT` — local receipt path
- `PACKPROOF_SMOKE_EMAIL`, `PACKPROOF_SMOKE_PASSWORD` — execution only

From `desktop/`, run:

```sh
node scripts/run-staging-acceptance.mjs --preflight
node scripts/run-staging-acceptance.mjs --execute-protocol-fixture
```

Preflight performs public GETs only, without credentials or remote writes.
`--execute-protocol-fixture` may run on Linux. Its report explicitly records the
real host OS and a **simulated Windows platform claim** in the synthetic request
fixture. It never changes `process.platform`, claims to have run Electron, or
reports native hardware acceptance. Capture dates, camera name and declaration
are disclosed synthetic request inputs; no physical shipment occurred.

On an actual Windows or macOS host, use `--execute-native-host` instead. This
uses the real host platform but still tests source fixtures, not webcam capture.
Native installation, camera, scanner, OS vault and hardware acceptance remain
separate release checks.

## Checks and cleanup

The test performs real Cognito sign-in and refresh, backend account binding,
desktop registration/replay, upload initialization/replay, multipart recovery,
original digest verification, evidence commitment, explicit synthetic
declaration, server finalization and manifest replay. It reads original bytes,
checks HTTP byte ranges and ZIP export, creates a temporary public viewing link,
verifies the shared original and revokes the link. No invitations, marketplace
connections, carrier registration, customer notifications or financial changes
are requested.

A report in `desktop/artifacts/staging-acceptance-<run-id>.json` is checkpointed
as IDs are created. It contains no password, access token, refresh token or
public bearer URL. Local login state stays in memory and is cleared afterward.
Any share link is revoked in cleanup. Test Proofs and evidence are deliberately
retained for audit; no records are deleted. If cleanup fails, inspect the
dedicated test account's access links and revoke them before disabling it.

After reviewing the report, disable the dedicated Cognito account using the
normal administrative operation. Record that outcome separately: the script
cannot certify administrative cleanup it did not perform. Retain failed
artifacts for diagnosis and use a fresh dedicated account for a new run.
