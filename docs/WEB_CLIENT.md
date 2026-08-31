# PackProof V2 web reference client

`web/` is the first-party reference client for the canonical Proof API. It is another surface, not another Proof model.

```text
PackProof Web
      |
Mobile App ---------- PackProof API
      |
      v
Canonical Proof Core
```

The client talks only to public REST DTOs. It does not import backend persistence code, infer authorization, or reconstruct Proof state.

## Authentication

The web app reuses the existing V2 adapters.

- Development: `POST /auth/dev/login` with a subject, then bearer token calls.
- Production: Cognito `USER_PASSWORD_AUTH` in the browser. The password never goes to the PackProof API. The access token is sent as `Authorization: Bearer`.

Session tokens are stored in `sessionStorage` for the tab only. A `401` clears the session and returns to sign-in. Route guards are not authorization; the server remains fail-closed.

## Discovery and retrieval

- Home calls `GET /me/proofs` and `GET /invitations`. Summaries are not treated as full Proofs.
- Create Proof can import a reference marketplace purchase (`POST /integrations/transactions/import`) or enter the transaction manually. The review screen renders the server transaction. See [TRANSACTION_INGESTION.md](TRANSACTION_INGESTION.md).
- Opening a Proof calls `GET /proofs/:id` and renders `packproof.proof.canonical/v1`.
- Cached `proofId` values in the URL are shortcuts only.
- Invitations addressed to the signed-in account appear in discovery. An invitation ID can also be accepted from home. Tokens from create/accept responses are discarded by the API client.

## Trust vocabulary

The Proof page labels every section:

- **PackProof fact** — receipt, digest, participant join, recorded events, lifecycle
- **User attestation** — participant statements recorded by PackProof
- **External data** — transaction/shipping fields supplied by a participant or integration

The UI does not present attestations or external fields as independently verified facts.

## External identity

`tenant_key + external_transaction_id → proof_id` is an immutable infrastructure binding. Editing `transaction.externalReference` changes display metadata only. The web client does not offer rebinding.

## Local development

```text
cd backend
set PACKPROOF_DEV_AUTH=true
set PACKPROOF_AUTH_MODE=dev
npm start

cd ../web
npm install
npm test
npm run typecheck
npm run dev
```

Vite proxies API paths to `http://127.0.0.1:3000`. Document navigations (`Accept: text/html`) are not proxied, so `/proofs/:id` remains the SPA route. JSON fetches still go to the API. Leave `VITE_PACKPROOF_API_BASE_URL` empty for that proxy. Cross-origin deployments set `PACKPROOF_WEB_ORIGINS` on the API.

## Commands

```text
npm test
npm run typecheck
npm run build
npm run preview
```

## Staging

The web client and mobile client are separate origins. Both talk to the same ECS API.

```text
cd infra
.\deploy-web.ps1
```

That command:

1. Deploys private S3 + CloudFront (`packproof-v2-staging-web`)
2. Builds `web/` with Cognito and the staging API URL baked in
3. Uploads `web/dist` and invalidates CloudFront
4. Sets `PACKPROOF_WEB_ORIGINS` on the existing Express API to the CloudFront origin

Staging web URL: `https://dvpmnwc27i8tw.cloudfront.net`

SPA routes such as `/proofs/:id` are served by CloudFront error fallback to `index.html`. The API stays on `https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws`. The API image must include the CORS middleware; setting `PACKPROOF_WEB_ORIGINS` on an older image has no effect.

Do not embed Cognito secrets, database credentials, or S3 keys. The web bundle is public.

## Deployment

Static files from `web/dist`. Staging uses S3 + CloudFront. Local Vite still proxies to `http://127.0.0.1:3000`. Cross-origin deployments set `PACKPROOF_WEB_ORIGINS` to the exact HTTPS origin.
