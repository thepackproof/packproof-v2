# PackProof website and workspace

The marketing website and the existing React workspace share the PackProof navy,
blue, and green palette, typography, account flows, and navigation.

| Route | Purpose |
| --- | --- |
| `/` | Main landing page |
| `/how-it-works` | Product workflow and FAQs |
| `/about` | Mission and product principles |
| `/contact` | Contact details and an explicitly labeled email-draft form |
| `/sample` | Interactive illustrative Proof; no customer data or fake media controls |
| `/privacy`, `/terms` | Existing legal drafts in the website layout |
| `/login`, `/signup` | Existing Cognito authentication, verification, and password recovery |
| `/app` | Authenticated Proof library and account-derived totals |
| Existing application routes | Proofs, receipt, activity, stores, packing, fulfillment, and developer tools |

`/new/privacy` and `/new/terms` remain supported. Protected Proof and invitation
deep links survive sign-in. A missing route gets a useful not-found page.

## Builds

The normal `web` build remains compatible with the existing AWS web deployment.
The repository-root build creates the private Sites preview: `dist/client` contains
the Vite build, and `dist/server/index.js` contains a small streaming API bridge.
It points to the existing staging API; it does not deploy or change the backend.
The bridge forwards account authorization and never forwards the private Site cookie.
Normal AWS deployments continue to use their existing API environment configuration.

Run `npm test` in `web` for the frontend suite. Run
`node --test web/scripts/sites-worker.check.mjs` at the repository root for bridge
checks. No browser QA or live account mutations were performed for this update.

## Launch details still requiring operational configuration

- Legal documents retain their existing draft status and unconfirmed entity,
  address, privacy contact, and jurisdiction fields.
- The contact form opens an email draft; sending remains the visitor's explicit action.
- Connected-provider authorization returns to the web origin configured on the
  existing API. That configuration must match the final public web domain.
- The evidence bucket now permits signed browser uploads from the new domain,
  the Sites preview, and the existing CloudFront web address. Object access still
  requires the existing authorization; the bucket remains private.
- OAuth provider registrations still use the existing API callback origin.
- The earlier audit's backend changes remain in their separate review workflow.

## Custom domain handoff

`deployment/thepackproof-domain.json` records the exact prepared DNS records and
the API web-origin change to apply after DNS is active. Both hostnames are attached
to the Site; DNS changes still require Cloudflare dashboard access. `www` redirects
to the apex with a 308 redirect, preserving paths and queries. The API bridge now
preserves upload idempotency keys. Deployment scripts preserve the canonical web
origin instead of overwriting it with the CloudFront hostname.

## Design sources

Original implementation inspired by the product compositions, restrained card
layouts, navigation, and tab interactions at [21st.dev](https://21st.dev):
[hero composition](https://21st.dev/@solaceui/components/hero-section-6),
[navigation](https://21st.dev/@manuarora700/components/resizable-navbar),
[feature layout](https://21st.dev/@meschacirung/components/features-8), and
[tabs](https://21st.dev/@ibelick/components/animated-tabs).

The existing PackProof logo is retained. `public/packproof-hero.png` is original
generated studio artwork of a kraft package, cyan tape, and subtle green lighting.
