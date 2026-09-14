# PackProof Capture Host SDK (private candidate)

This server package creates transaction-bound launch links for storefront/WMS actions. It uses the existing `/v1` API tenant boundary, `evidence:write` scope, rate controls, and encrypted idempotent responses. The tenant must own the Proof. The person opening the link must authenticate as the same merchant user associated with the tenant; cross-user delegated grants are not yet supported.

```js
import {CaptureHostClient,verifyCaptureReceipt} from './server.mjs';
const capture = new CaptureHostClient({
  apiBaseUrl: process.env.PACKPROOF_API_ORIGIN,
  siteOrigin: process.env.PACKPROOF_SITE_ORIGIN,
  apiKey: process.env.PACKPROOF_API_KEY,
});
const {launchUrl,expiresAt} = await capture.createIntent(proofId, {
  idempotencyKey: `${fulfillmentId}:capture:1`, allowedSurfaces:['ANDROID','WEB'],
});
// Render launchUrl as an order-page action or QR. Do not log it or send it to analytics.
// Completion is polled through the existing authorized Proof/manifest API.
const valid = verifyCaptureReceipt(receipt,{proofId,captureId,trustedKeys});
```

The browser launch page offers native handoff and browser fallback. Opening the page does not redeem the token. Only an authenticated POST consumes it. A receipt contains the signed canonical Proof manifest, which covers the capture root, source commitments and event timeline. Missing signatures, untrusted keys, wrong Proofs, changed manifests and incomplete capture states fail receipt verification. Never infer a signature from an HTTP success.

Capture Core source: `backend/src/capture/core.ts`. Android's React Native bridge and web adapter import that same pure module. It has no Node, camera, UI, network or wall-clock dependencies. The core is currently TypeScript; Rust/WASM/Swift/AAR distribution and partner certification have not passed their release gates. Do not publish this package as a certified public SDK.

Existing Proofs and final manifests retain their versions and bytes. New capture clients negotiate `packproof.capture/1` and core `1.0.0`; unsupported versions fail before binding. Breaking canonical changes require a new schema and retained verifier. Android/WEB can run this candidate; iOS/warehouse identifiers in the schema describe future adapters and do not indicate production support.
