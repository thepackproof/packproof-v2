# Merchant claim review interface

The web SignatureWorkbench can show the merchant case workflow when built with
`VITE_PACKPROOF_CLAIM_EXPORTS_ENABLED=true`. The default remains off. API feature
flags, direct human merchant authority and recent authentication are still
required; this build setting grants no API access or provider authorization.

The current reviewer loads only direct Stripe payments already bound to this
finalized Proof, using `/proofs/{id}/claim-cases/options`. The endpoint shares
the existing claim access checks, is bounded to 100 payment/line choices and
returns no credentials or provider connection claim. Dispute identity and
affected line choices are recorded once. Subsequent portal observations append
revisions with the expected current digest and an explicitly later observation
time. Lost-response retries keep the same request and Idempotency-Key; the UI
reloads the latest case after reconciliation.

The form labels data as merchant reported and unverified. It requires the actual
account/payment choice, portal reason/network/status, observation time, reported
deadline and permitted actions. Recording RESPOND or ACCEPT never performs it.
No line selection means payment-only scope, shown as a limitation. Unsupported
or stale cases can be inspected but cannot open file preparation.

The export selection uses the exact claim revision and recorded deadline. Only
the matching current Stripe profile is offered. Saved export identifiers are
scoped to authenticated account, Proof, preview and claim revision; late replies
from an earlier context cannot repopulate a new review. Each preview's digest is
checked against the exact file. Approval explicitly means
EXPORT_FOR_MERCHANT_REVIEW and includes the case and artifact digests.
PRESERVING and APPROVAL_PRESERVING are visible states. Pending approval does not
trigger a download; the reviewer downloads after the durable state appears.
Changed cases require a new preparation and approval. Provider submission,
portal acceptance and claim outcome remain separate.

Component and API tests exercise lost responses, frozen identity, affected
lines, stale/closed/unknown/pending cases, crossed Proofs, revoked access,
claim-bound preparation, mismatched cached revisions and delayed approval.
CI uses the committed dependency lock. Browser component tests do not replace
actual browser/device lifecycle or merchant usability acceptance. Activation
also depends on the storage, migration, runtime-role and recovery gates in
RECIPIENT-PRESERVATION.md and CLAIM-REVIEW-EXPORTS.md.
