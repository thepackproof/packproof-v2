# Isolated required-MFA identity

`isolated-identity.json` creates a test-only Cognito pool and public client. It requires software-token MFA, administrator-only account creation and recovery, a 16-character mixed password, short access tokens and token revocation. It has no production identity reference, email/SMS sender, payment integration or application endpoint.

The template defaults `RunnerEnabled` to `false`. A temporary CodeBuild runner can be enabled to execute the pinned `backend/scripts/isolated-identity-acceptance.py`. Its role can administer only this new pool, write its own logs and upload synthetic acceptance reports. It cannot read the database owner secret or edit IAM. The test suppresses account invitations; passwords, tokens and TOTP seeds remain in process memory.

The successful run on `ffd03b292564487977ea55898a8d63e88b13af7a` passed nine checks: required configuration, self-registration denial, wrong-password denial, password-only MFA setup without tokens, TOTP enrollment, subsequent MFA challenge, wrong-code denial, correct-code authentication and Cognito rejection of a signed-out token. It removed the synthetic user. The exact encrypted S3 archive was downloaded and verified. See [identity evidence](../../docs/partner-foundation/isolated-identity-evidence-2026-10-20.json).

After acceptance, update `RunnerEnabled=false` through a reviewed change set. Only the runner and its role should be removed. The pool and client remain protected and retained; encrypted logs and the versioned artifact remain. This cleanup was verified at 02:06 UTC on 21 October 2026 (20 October in America/New_York); the pool contains no users.

The pool is not connected to a deployed test API or web origin. This proves provider behavior for a synthetic software token, not human authenticator enrollment, device acceptance or application JWT/session revocation. Use the existing Cognito integration and current application session checks when deploying the separate test service. Record that additional evidence before enabling a cohort.
