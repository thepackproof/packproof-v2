# PackProof V2 backend

Modular monolith. Domain commands own Proof state. HTTP only translates requests.

## Commands

- `createTransaction`
- `importTransaction`
- `importShipmentEvents`
- `getShipmentIntegrity`
- `executeTrustedShipmentSync`
- `createOrGetProof`
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
- `s3` — private bucket. The API issues a time-limited presigned PUT for one object key. The client uploads bytes directly to S3. `commitEvidence` independently verifies existence, size, content type, and SHA-256 before changing Proof state.

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

Object keys are generated server-side as `evidence/<proofId>/<evidenceId>/object`. Clients cannot choose bucket paths.

## Trusted integration credentials

`PACKPROOF_CREDENTIAL_STORE` selects the server-side store (`memory`, `env`, or `secrets-manager`). Domain code never reads env vars, Secrets Manager, or files directly. Connections store a credential *reference*, not tokens.

When `PACKPROOF_CREDENTIAL_STORE=secrets-manager`, the ECS task role should allow:

```json
{
  "Sid": "TrustedIntegrationSecrets",
  "Effect": "Allow",
  "Action": ["secretsmanager:GetSecretValue"],
  "Resource": "arn:aws:secretsmanager:REGION:ACCOUNT:secret:packproof/v2/integrations/*"
}
```

Use the default AWS credential chain (task role). Do not put static AWS keys or provider tokens in source, `web/` env, or Expo public env. Do not deploy live carrier credentials in this slice.

### Optional live S3 test

Disabled unless `PACKPROOF_S3_INTEGRATION=1` and S3 storage is configured. Uses prefix `evidence/_packproof_test/` and deletes those objects afterward. Never required for `npm test`.

## Web origin

Browser clients listed in `PACKPROOF_WEB_ORIGINS` receive CORS headers. The first-party reference client is `web/`. Staging hosting is S3 + CloudFront via `infra/deploy-web.ps1`. See `docs/WEB_CLIENT.md`.
