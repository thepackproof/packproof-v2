# Security review — 11 October 2026

This records the 17 open CodeQL findings observed on base
`0424f154edc1bcbd97f463f3a64e90e109d67e87` and the scoped changes on
`fix/security-release-followthrough`. Local tests establish the behavior described
below. **Closure in GitHub is pending a fresh analysis of the final committed
source and a separate reviewed disposition of #21.** No broad scanner exclusions,
reduced thresholds, or alert suppressions were added.

## Finding-to-evidence mapping

| Alert | Source and resulting behavior | Regression coverage |
| --- | --- | --- |
| #1 | `backend/src/server-app.ts`: a shared IP budget runs before eBay account-deletion signature verification on POST. The independent GET challenge retains its existing behavior. | `backend/tests/ingress-rate-limit.test.ts`: invalid-signature burst stops before further verifier calls; GET challenge still succeeds. |
| #3, #4, #5 | `backend/src/server-app.ts`: participant email-subscription GET, POST and DELETE share a budget across methods and Proof ids, before authentication or delivery work. Participant authorization remains required. | `backend/tests/ingress-rate-limit.test.ts`: all three methods stop at the same limit; spoofed forwarding headers and changed Proof ids do not reset it. Existing notification/privacy tests cover authorization and delivery semantics. |
| #7 | `backend/src/integrations/shopify/shop.ts`: native prefix removal and first-slash indexing replace repeated regex suffix scanning. Embedded line terminators fail rather than turning a malformed domain into a valid one. | `backend/tests/shopify-shop-security.test.ts`: handles, domains and ordinary HTTP(S) paths; deceptive hosts, credentials and line terminators; 250,000-slash near-matches in a deadline-limited subprocess. Existing Shopify suites also pass. |
| #13 | `backend/src/platform/router.ts`: public OpenAPI file delivery receives its own ingress budget. Existing API-key authentication and tenant budgets remain separate. | `backend/tests/ingress-rate-limit.test.ts`: specification access is limited while protected API routes still require API credentials. |
| #14, #15, #16 | `backend/src/intake/order-intake.ts`: parse5 fragment parsing replaces script/style/tag stripping. Iterative traversal extracts text without executing or serializing HTML and excludes script/style subtrees, comments and inert templates. The 20,000-character limit precedes parsing; the original source hash and confirmation requirement remain unchanged. | `backend/tests/order-intake-security.test.ts`: mixed case, malformed closing tags/attributes, quoted `>`, raw/nested content, comments, SVG, templates, entities, deep nesting, exact input limits, valid order fields and original-source SHA-256. |
| #19 | `backend/src/domain/shipment-notifications.ts`: reject non-Buffer bodies before measuring byte length, converting text or performing database work. Bounded original Buffers retain normal notification processing. | `backend/tests/webhook-input-types.test.ts`: strings, arrays, JSON Buffer lookalikes, Uint8Array, objects with hostile coercion, null and numbers; accepted Buffer and oversized rejection. Existing shipment tests preserve notification behavior. |
| #20 | `backend/src/billing/stripe-adapter.ts`: validate Buffer body and scalar string signature/secret at runtime before byte limits, parsing or HMAC work. Original bytes remain the signed input. | `backend/tests/webhook-input-types.test.ts`: malformed body/header/secret types and hostile coercion; original binary bytes, changed bytes and size limits. Existing Stripe tests cover signature rotation and freshness. |
| #21 | `backend/src/hash.ts`, reached by `backend/src/platform/tenants.ts`: assessed as a **password-hashing false positive**, with rationale below. No hash implementation or authentication compatibility was changed. | `backend/tests/api-key-token-security.test.ts`: real CSPRNG generation, entropy request size, digest-only storage, strict bearer format, changed/unknown tokens and immediate revocation. |
| #22 | `browser-companion/tests/parser.test.cjs`: the reported regex was a literal assertion against preserved script-like text, not a production sanitizer. Exact equality of the observed title and parsed source JSON now expresses that contract directly. | The same test file verifies mixed-case and malformed markup-like text remains plain text, alongside existing visible-DOM/ambiguous-page rejection tests. |
| #23 | `mobile/src/capture/upload-transport.ts`: exact AWS suffix validation followed by one pass over hostname labels replaces ambiguous S3-host repetition. HTTPS, PUT, admission-token and already-received checks remain intact. | `mobile/tests/upload-handoff.test.ts`: regional, dual-stack and accelerated S3 forms; deceptive hosts; a 100,000-hyphen near-match subprocess; existing upload/recovery handoff behavior. |
| #24 | `backend/src/app.ts`: the actual first-party bearer/scoped-intake authentication boundary and the earlier multipart PUT boundary receive a shared ingress budget. Development-login writes have a separate budget. Existing public/provider exclusions retain their authorization rules. | `backend/tests/ingress-rate-limit.test.ts`: real bearer/intake/multipart routes stop before authentication/storage lookup once limited, normal concurrent clients work below the ceiling, and exempt public/provider paths retain exact expected outcomes. |
| #25 | `backend/tests/system-admin.test.ts`: its synthetic authentication fixture now uses the same production first-party ingress policy before authentication. Production protection is covered independently by #24. | Existing system-admin authorization tests plus the production-route admission regressions; this fixture change alone is not evidence of production protection. |
| #28 | `infra/admin-runtime-credentials.mjs`: a forward-only session-options parser replaces nested regex repetitions. It preserves the three allowed timeout names, integer values, supported units and whitespace while rejecting unreviewed settings before opening a database connection. | `infra/tests/admin-runtime-credentials.test.mjs`: valid/invalid option matrices, retained URL options, and deadline-limited subprocesses with 10,000 repeated options or 200,000 spaces. The full credential/privilege suite passes and is now included after the Backend CI build. |

## Why #21 is not password storage

`issueApiKey` constructs the bearer token exclusively from the environment prefix
and `randomBytes(32).toString('base64url')`. The caller cannot select its secret.
`api_keys` stores a SHA-256 lookup digest and a bounded diagnostic prefix, never
the complete token. `authenticateApiKey` accepts the exact issued token format,
looks up the digest, excludes revoked keys, and rechecks owner eligibility.

The stored 20-character diagnostic prefix reveals part of the random suffix.
For `pp_live_` (8 fixed characters), it reveals 12 base64url characters, or 72
random bits, leaving **184 unknown bits** of the original 256. For `pp_sandbox_`
(11 fixed characters), it reveals 9 base64url characters, or 54 random bits,
leaving **202 unknown bits**. These counts assume the complete diagnostic prefix
is known and do not claim that all 256 bits remain secret after prefix storage.

Node documents [`crypto.randomBytes`](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptorandombytessize-callback)
as a cryptographically strong random-data generator. CodeQL's
[insufficient password hash guidance](https://codeql.github.com/codeql-query-help/javascript/js-insufficient-password-hash/)
addresses computationally expensive hashing for passwords. The distinction here
is established by the actual server-only random-token issuer and its regression
tests, rather than by treating the password guidance as inapplicable generally.

These are high-entropy, server-generated API capabilities, not human-selected
passwords needing a password-derivation function. The regression observes the
32-byte CSPRNG request while retaining Node's actual random output, verifies both
live and sandbox issuance/storage, and rejects caller-supplied passwords, stored
prefixes, altered/unknown tokens and revoked tokens. The shared SHA-256 helper
also serves evidence-integrity operations. Replacing it globally with a password
KDF would change unrelated evidence semantics without addressing a password
storage flow. This rationale requires a narrow reviewed alert disposition; it is
not a blanket exception for password hashing.

## Dependencies and implementation boundaries

- `express-rate-limit` **8.7.1** uses an atomic PostgreSQL store over the existing
  `http_rate_windows` table. Replicas share the budget, failed attempts count,
  database failures stop protected work, expired rows use the existing cleanup,
  raw IPs/credentials are not stored, and IPv6 callers are grouped by /56.
- `parse5` **8.0.1**, with locked `entities` **8.1.0**, provides actual HTML
  parsing. Node 22 meets the dependency's runtime requirement. Entity decoding
  produces plain text; decoded markup is never parsed a second time. Inert
  template contents are intentionally not treated as visible order facts.
- Fresh backend, web, mobile and desktop dependency audits at the reviewed
  working tree reported **zero findings at every severity**. Final-source
  audit/CI evidence is still a separate gate.

## Local validation and CI coverage

- Regex/HTML scope: **10 backend files / 116 tests passed**; **6 mobile upload
  tests passed**; **15 infrastructure credential tests and 4 browser parser
  tests passed**. Backend and mobile type checks passed.
- Actual baseline source reproduced blocking near-matches for #7/#23/#28 in
  isolated subprocesses and extraction of a hidden script field for #14–16.
  Corrected tests verify outcomes and deadlines without hanging the test runner.
- Rate-limiting scope: **17 new regression tests passed**. Additional affected
  runs included **4 files / 36 tests** for ingress, admin, lifecycle/resume and
  capture-shipping; these overlap and must not be added together as unique tests.
- Runtime-type and API-token scope: **4 files / 46 tests passed**, including
  **23 webhook boundary tests** and **4 API-token tests**. The same 23 boundary
  tests against baseline produced **9 failures / 14 passes**. Backend type
  checking passed; the overlapping counts are not additive.
- `mobile/package.json` now includes `upload-handoff.test.ts` in `test:recovery`,
  which the existing Mobile CI job executes. The combined command passed
  **26 tests** locally.
- Browser companion tests are already included in the Source secrets and release
  tooling CI job. Backend regression files are included by the normal Vitest run.
- The Backend CI job now runs
  `node --test ../infra/tests/admin-runtime-credentials.test.mjs` immediately
  after `npm run build`, when the imported backend migration output and PGlite
  dependency are available. This includes the #28 regressions and full existing
  credential/privilege suite in CI.

## Remaining release checks

The new first-party ingress ceiling is **600 requests per minute per resolved IP**.
The published Sites worker forwards a bounded header allowlist and does not
explicitly forward a trusted original-client IP. The backend defaults to trusting
no proxy. Before deploying this backend change, verify the actual edge/proxy
identity chain so multiple browser users are not unintentionally charged to one
proxy bucket. Do not resolve this by blindly trusting caller-supplied forwarding
headers. Local proxy/spoofing tests establish middleware behavior, not the live
deployment's identity boundary.

Fresh CodeQL results, final-source CI, build/package identity, deployment checks
and physical-device acceptance remain distinct gates. This review does not claim
that any new binary was published or that physical-device acceptance ran.

Primary guidance: [CodeQL HTML filtering](https://codeql.github.com/codeql-query-help/javascript/js-bad-tag-filter/),
[CodeQL regex denial of service](https://codeql.github.com/codeql-query-help/javascript/js-polynomial-redos/),
and [parse5 documentation](https://parse5.js.org/).
