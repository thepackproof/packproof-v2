# PackProof Zendesk claims sidebar

Private, read-only claims sidebar. Install and authorize it using [the claims integration runbook](../../docs/PREPRODUCTION_CLAIMS_2026-09-09.md). The API must include migration 059 before installation.

The ZIP must contain `manifest.json`, `translations/en.json`, and `assets/` at its root. No credentials belong in the ZIP. Set `claims_token` securely during installation. Use a key with only `claims:read` and authorize each existing Proof against its seller-reviewed sharing grant.

The current package points at PackProof's staging API. For a different environment, update both the manifest domain whitelist and `apiOrigin` together; update the canonical viewer hostname check if that deployment uses a different web origin. Do not accept an arbitrary runtime URL for a secure-setting destination.

The bundled header and administrator logos reuse the approved PackProof app icon. Installation-setting labels are localized under `app.parameters`; the secure key is restricted to header substitution.
