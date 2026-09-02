# PackProof V2 backend

Modular monolith. Domain commands own Proof state. HTTP only translates requests.

## Commands

- `createTransaction`
- `importTransaction`
- `importShipmentEvents`
- `getShipmentIntegrity`
- `executeTrustedShipmentSync`
- `executeCommerceFulfillmentSync`
- `resolvePackingStation`
- `createOrGetProof`
- `searchUsers`
- `searchUsersForProof`
- `createInvitation`
- `acceptInvitation`
- `initializeEvidenceUpload`
- `commitEvidence`
- `finalizeProof`

## Environment

See `.env.example`.

## Authentication

`PACKPROOF_AUTH_MODE` selects the adapter explicitly:

- `dev` — development bearer tokens and `POST /auth/dev/login` when `PACKPROOF_DEV_AUTH=true`. Default. No Cognito required.
- `cognito` — verify Cognito JWTs, map `sub` through `auth_identities`, and use the internal PackProof `user_...` id. Development login is disabled.

Cognito is an authentication adapter only. Proofs continue to reference PackProof user ids.

## Evidence object storage

`PACKPROOF_OBJECT_STORAGE` selects the adapter explicitly:

- `local` — files under `PGLITE_DIR/objects` and `PUT /upload/:token`. Default. No AWS required.
- `s3` — private bucket. The API issues a time-limited presigned PUT for one staging key. The client uploads bytes directly to S3. `commitEvidence` hashes an ETag-locked snapshot, promotes it to a server-only content-addressed key, and stores that committed key with the independently verified size, content type, and SHA-256. A still-valid staging PUT cannot alter the object referenced by the Proof.

`npm test` uses the local adapter and in-memory fakes. It does not require AWS or network access.

### S3 variables

| Variable | Purpose |
| --- | --- |
| `PACKPROOF_OBJECT_STORAGE=s3` | Enable the S3 adapter. No auto-detection. |
| `PACKPROOF_S3_BUCKET` | Private evidence bucket. Alias: `AWS_S3_BUCKET`. |
| `AWS_REGION` | Bucket region. |
| `PACKPROOF_S3_UPLOAD_EXPIRES_SECONDS` | Presigned PUT lifetime. Default `3600`. Max `604800`. |

Runtime credentials come from the default AWS chain (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, `AWS_PROFILE`, or an instance/task role). Do not put access keys in mobile code, `app.json`, or committed files.

### Least-privilege IAM

Allow only the API runtime role to manage evidence objects:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EvidenceObjects",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:HeadObject"],
      "Resource": "arn:aws:s3:::BUCKET_NAME/evidence/*"
    }
  ]
}
```

Keep the bucket private. Do not grant public `s3:GetObject`. Presigned URLs are the only client upload path and expire.

Upload keys are generated server-side as `evidence/<proofId>/<evidenceId>/object`. Committed objects use `evidence/<proofId>/<evidenceId>/committed/sha256-<digest>`. Clients cannot choose bucket paths and never receive PUT authorization for committed keys. Retrying initialization after commitment returns `EVIDENCE_ALREADY_COMMITTED`; clients recover by fetching the canonical Proof.

## Trusted integration credentials

`PACKPROOF_CREDENTIAL_STORE` selects the server-side store (`memory`, `env`, or `secrets-manager`). Domain code never reads env vars, Secrets Manager, or files directly. Connections store a credential *reference*, not tokens.

When `PACKPROOF_CREDENTIAL_STORE=secrets-manager`, the ECS **task role** (the application SDK role, not the task execution role) should allow:

```json
{
  "Sid": "TrustedIntegrationSecrets",
  "Effect": "Allow",
  "Action": [
    "secretsmanager:GetSecretValue",
    "secretsmanager:CreateSecret",
    "secretsmanager:PutSecretValue",
    "secretsmanager:DeleteSecret"
  ],
  "Resource": "arn:aws:secretsmanager:REGION:ACCOUNT:secret:packproof/staging/integrations/*"
}
```

Staging EasyPost uses secret name `packproof/staging/integrations/easypost`. See [docs/EASYPOST_TRACKING_INTEGRATION.md](../docs/EASYPOST_TRACKING_INTEGRATION.md).

Local development (`PACKPROOF_DEV_AUTH=true`) may bind a connection with `POST /dev/integrations/easypost/connect` and `{ "transactionId", "credentialReference" }` only. Clients must not send API keys. Staging Cognito does not register `/dev` routes; operators bind connections in SQL after creating the secret.

Use the default AWS credential chain (task role). Do not put static AWS keys or provider tokens in source, `web/` env, or Expo public env. EasyPost is implemented as a test/staging tracking adapter, not a production carrier rollout.

### Optional live S3 test

Disabled unless `PACKPROOF_S3_INTEGRATION=1` and S3 storage is configured. Uses prefix `evidence/_packproof_test/` and deletes those objects afterward. Never required for `npm test`.

## Web origin

Browser clients listed in `PACKPROOF_WEB_ORIGINS` receive CORS headers. The first-party reference client is `web/`. Staging hosting is S3 + CloudFront via `infra/deploy-web.ps1`. See `docs/WEB_CLIENT.md`.

## Migrations

SQL files in `migrations/` apply in filename order at process start (`migrate()`). Staging/production must receive new files through the normal deploy path. Do not edit live rows by hand.

`013_fulfillment_capture.sql` adds `evidence_type_check` (`SELLER_EVIDENCE` | `FULFILLMENT_CAPTURE`). Existing rows are preserved. It does not rewrite finalized Proofs. Merchant finalization after this migration requires committed `FULFILLMENT_CAPTURE`; already-finalized Proofs stay finalized.

`016_custody_workflow.sql` adds `workflow_type`, custody tables, and extends `evidence_type_check` with `ASSET_CAPTURE`, `PACKING_CAPTURE`, `RECEIPT_CAPTURE`. See [docs/CUSTODY_WORKFLOW.md](../docs/CUSTODY_WORKFLOW.md).

`017_connected_accounts.sql` adds `connected_accounts` and account-scoped `account_audit_events`. OAuth tokens are not stored in those tables. See [docs/CONNECTED_ACCOUNTS.md](../docs/CONNECTED_ACCOUNTS.md).
