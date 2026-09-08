# Optional billing continuation — September 7, 2026

The free pilot remains available without any billing provider, offer or customer configuration. This change does not create a price, start a subscription or charge a customer during deployment.

Implemented endpoints under authenticated `/me/billing`:

| Endpoint | Result |
|---|---|
| `GET /offer` | Exact approved offer and SHA-256 for explicit acceptance; disabled when checkout is not configured |
| `POST /checkout` | A hosted Stripe Checkout session for the signed-in user and their accepted offer hash |
| `POST /checkout/complete` | Authenticated provider re-fetch, customer/subscription/consent verification, then prospective offer enrollment |
| `GET /status` | Own-account subscription status, trial end, cancellation dates and estimated base renewal amount/date |
| Existing invoices/cancellation portal | Own-account invoice reads and customer-confirmed cancellation review |

Checkout accepts only `operationId`, `offerVersion` and `acceptedOfferSha256`. Completion accepts only `operationId`. Price, customer, provider account, environment and return URLs cannot be chosen by the browser. An operation records immutable accepted terms before its first provider request; retries reuse a stable provider idempotency key. An uncertain creation older than 23 hours requires reconciliation rather than risking another session outside Stripe's idempotency window. Existing active/unpaid subscriptions and outstanding checkouts prevent duplicate enrollment.

The provider price must match the approved USD monthly licensed offer exactly. Hosted terms acceptance and active/trialing subscription state are required. New allowance periods begin when verified locally and are never retroactively attached to prior free recordings. A separately monitored `billing-enrollment` worker refreshes completed checkouts and current periods in bounded batches; failure does not stop the independent payment reconciliation worker. Current billing settings support a single configured approved monthly offer. Changes to offers and migrations between offers require separate provisioning; usage-priced checkout is deliberately rejected.

New ordinary seller captures reserve their approved allowance atomically within the same transaction as capture creation. Reservations and finalized/metered Proofs are deduplicated, including finalizations that the usage worker has not yet counted. An in-progress Proof reserves capacity until the period ends; retrying or retaking that same Proof reuses its reservation. An expired subscription blocks new reservations while existing capture recovery and all saved evidence access remain independent. Stage supplements do not consume another ordinary Proof allowance. Each capture stores immutable recording size/duration caps; actual media duration is checked by the existing isolated decoder at commitment.

Enable only after an offer and the existing exact-release publication receipt have been provisioned:

```
PACKPROOF_STRIPE_CHECKOUT_ENABLED=true
PACKPROOF_STRIPE_CHECKOUT_OFFER_VERSION=<approved-offer-version>
PACKPROOF_STRIPE_CHECKOUT_PRICE_REFERENCE=<existing-price-reference>
PACKPROOF_STRIPE_CHECKOUT_SUCCESS_URL=<fixed-https-account-page>
PACKPROOF_STRIPE_CHECKOUT_CANCEL_URL=<fixed-https-account-page>
```

The existing managed Stripe account/environment/API-version/credential and reconciliation-baseline settings still apply. No credentials belong in these non-secret settings or the browser. A current trusted publication receipt is required both for enrollment and prospective renewal admission. Operational monitoring must therefore surface failed publication-receipt renewal, rather than silently making unapproved offers active.

The `nextCharge` response is explicitly an estimate of the base subscription price. Taxes, credits, adjustments and final invoice payment status are not inferred. Live payment/refund/cancellation observation and financial reconciliation remain real operating acceptance requirements. Provider activation is not required for tonight's free merchant test.

Verification: focused tests cover unchanged free HTTP capture, exact offer consent, provider price mismatch, checkout retries, account substitution, terms consent, verified enrollment, trial/cancellation projection, concurrent allowance admission, persisted recording limits and recovery after offer expiry. Provider fixtures are synthetic and no payment or customer mutation was performed against Stripe.

Primary API references used for implementation: [create Checkout Session](https://docs.stripe.com/api/checkout/sessions/create), [retrieve Checkout Session](https://docs.stripe.com/api/checkout/sessions/retrieve), [subscription object](https://docs.stripe.com/api/subscriptions/object).
