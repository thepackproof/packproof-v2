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

- Orders (`/app` or `/fulfillment`) is the starting queue. A row opens the ordinary camera preview at `/station?proof=…`; recording starts only after Record packing. `/station` without an order is the batch queue using that same recorder and completion pipeline.
- Manual shipment (`/new`) asks for the item, with optional details collapsed. Legacy `/new/scan` redirects here. No ordinary pre-scan, extra photo or finish rescan is required.
- Finish saves the original before review. Review resolves label ambiguities, shows the exact shipment statement and requires deliberate confirmation. Upload, commit, attestation and finalization then resume automatically and idempotently. Only authoritative FINALIZED is a saved Proof. Browser confirmation does not claim Android strong biometrics.
- Proofs (`/proofs`) presents Needs attention and Saved Proofs with search. The canonical viewer uses Recording / Activity / Tracking, preserves playback/scroll state and puts integrity/actions behind contextual disclosures. Grading, receiver capture, invitations, receipt and return work remain contextual on the same Proof.
- Account (`/account`) is a compact settings list. Sales channels (`/stores`) joins connection identity, permission/reauthorization, actual order health, sync time and server-owned automation in one provider card. Identity-only providers never imply order import.
- Recordings on this device exposes retained browser originals and recoverable work. A local copy cannot be discarded before required durable receipts.
- Account → Privacy & account and the public `/new/delete-account` page provide authenticated, explicit deletion requests and authoritative status. Request receipt does not claim immediate erasure.
- Guest viewing (`/p/:token`) renders the same underlying record within the granted disclosure scope. Server authorization, revocation and evidence digest checks remain authoritative; private raw history is not leaked.

See [redesign contracts and release gates](ui-ux-redesign-2026-09-08/README.md). Older descriptions of scan/rescan and separate manual finalization are superseded for this candidate.

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
