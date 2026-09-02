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

- Home is **My Proofs**: In Progress / Completed, search, filter, and a create button. Invitations appear in In Progress. Avatar opens Account.
- Create, Packing Station, Fulfillment, and Connected Stores are reached from Create or Account, matching the Android client.
- Opening a Proof calls `GET /proofs/:id` and renders `packproof.proof.canonical/v1`, including the server chronology and shipment observations.
- **Packing Station** (`/station`) is a persistent pack surface: scan or identify an order, record packing video as `FULFILLMENT_CAPTURE`, rescan the same canonical transaction to finish (USB/keyboard wedge), submit through the canonical evidence commands, then return to READY. Finished Packing remains a secondary fallback. Browser camera barcodes are not used; live camera barcodes are on mobile. See [PACKING_STATION.md](PACKING_STATION.md).
- **Fulfillment** (`/fulfillment`) is the seller packing queue from `GET /me/fulfillment-queue`. Opening a row shows transaction context. Packing evidence is required before complete; attestation is attribution. Orders without capture link into Packing Station.
- **Stores** (`/stores`) lists commerce connections that can sync fulfillment-eligible orders. Open it from Account → Connected stores. In development, Connect Demo Storefront and Sync now call server-owned reference routes. Connect Shopify from Account → Connected Accounts; synced shops then appear here. Production/Cognito mode does not show a fake Connect Shopify control on this screen.
- **Account** (`/account`) lists canonical connected accounts (`GET /me/connected-accounts`): eBay, Shopify, Google, and Meta/Facebook. Connect opens the official provider OAuth page; the API callback returns to `/account`. See [CONNECTED_ACCOUNTS.md](CONNECTED_ACCOUNTS.md).
- Create Proof can import a reference marketplace purchase (`POST /integrations/transactions/import`) or enter the transaction manually. The review screen renders the server transaction. See [TRANSACTION_INGESTION.md](TRANSACTION_INGESTION.md).
- Opening a Proof calls `GET /proofs/:id` and renders `packproof.proof.canonical/v1`, including the server chronology and shipment observations.
- **Guest viewing** (`/p/:token`) calls unauthenticated `GET /public/proofs/:token` and renders live status only. It is not a workspace and cannot mutate the Proof. Participants create links with `POST /proofs/:id/access-links`.
- **Grading submission** on Create calls `POST /proofs` with `workflowType: GRADING_SUBMISSION`. The Proof page prefers server `nextAction` and shows Item N / Documented / Packed / Handed off / Received. Commerce packing stays `FULFILLMENT_CAPTURE` via Packing Station.
- Cached `proofId` values in the URL are shortcuts only.
- Invitations addressed to the signed-in account appear in discovery (`GET /invitations`). Accepting uses the invitation id. Tokens from create/accept responses are discarded by the API client.
- Sellers add a participant by searching PackProof usernames or display names (`GET /proofs/:id/users/search`) and inviting the selected `userId`. Relationship state (You / Already participating / Invitation pending / Invite) comes from the server. Raw invite tokens are not shown. An invitation-ID accept control remains as a collapsed fallback.

## Trust vocabulary

The Proof page labels every section:

- **PackProof fact** — receipt, digest, participant join, recorded events, lifecycle
- **User attestation** — participant statements recorded by PackProof
- **External data** — transaction/shipping fields supplied by a participant or integration

The UI does not present attestations or external fields as independently verified facts.

Chronology categories (PackProof event, commerce event, carrier observation) name the source of a timeline entry. They are not stronger/weaker evidence.

Shipment observations may appear after “Core PackProof finalized”. They did not change the frozen core digest.

Finalized Proofs also load `GET /proofs/:id/shipment-integrity` and render a compact shipment-record panel from the server verification result. The browser does not recompute hashes. The panel reports PackProof’s stored-record integrity, not that a carrier’s real-world statement is true.

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

Vite proxies API paths (`/me`, `/proofs`, `/dev`, `/oauth`, and the other API prefixes) to `http://127.0.0.1:3000`. Document navigations (`Accept: text/html`) are not proxied, so `/proofs/:id` remains the SPA route. JSON fetches still go to the API. Leave `VITE_PACKPROOF_API_BASE_URL` empty for that proxy. Cross-origin deployments set `PACKPROOF_WEB_ORIGINS` on the API.

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

Public legal pages (no sign-in): `/new/privacy` and `/new/terms`. The production build emits static HTML at those paths so CloudFront and URL checkers receive the policy text without executing JavaScript. Other SPA routes such as `/proofs/:id` are served by CloudFront error fallback to `index.html`. The API stays on `https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws`. The API image must include the CORS middleware; setting `PACKPROOF_WEB_ORIGINS` on an older image has no effect.

Do not embed Cognito secrets, database credentials, or S3 keys. The web bundle is public.

## Deployment

Static files from `web/dist`. Staging uses S3 + CloudFront. Local Vite still proxies to `http://127.0.0.1:3000`. Cross-origin deployments set `PACKPROOF_WEB_ORIGINS` to the exact HTTPS origin.
