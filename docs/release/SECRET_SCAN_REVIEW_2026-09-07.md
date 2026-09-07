# Redacted source-secret scan review — 2026-09-07

Reviewed hosted CI run `34087260300`, Source secrets job `101633568556`, remote source commit `fe50c1caec535cc6c1361933e396bb2e0bba5efd`. The scanner reported six findings representing four distinct values. Only rule, path, line and commit metadata was printed during investigation; matched values are omitted from this report.

| Rule | File | Reported commit(s) | Review conclusion |
| --- | --- | --- | --- |
| `generic-api-key` | `docs/RELEASE_2026-09-05.md` | `e0ccb8a83f458a1f7c41209e942b70052a1acf9d` | The build table contains a CodeBuild execution UUID. It identifies a build and does not authenticate a caller. |
| `generic-api-key` | `backend/tests/notification-merge.test.ts` | `d812b787e925e7708027bd4c9e54684ce3664f16` | Fixed tracker-link signing phrase supplied directly to an isolated test harness. Delivery is an injected local function, with no provider credential exchange. |
| `generic-api-key` | `backend/tests/product-hardening.test.ts` | `d812b787e925e7708027bd4c9e54684ce3664f16`, `a0d5bf1fe56c5cc5764e7234ebbda0a688910e2c`, `d7a0966e8a12d597229282d39ca655e6e8d66cfa` | The same fixed test tracker-link signing phrase appears in all three historical blobs; equality was checked without printing the value. |
| `stripe-access-token` | `backend/tests/program-metrics-stripe.test.ts` | `fe50c1caec535cc6c1361933e396bb2e0bba5efd` | Explicitly synthetic test-mode API-key fixture. The adapter receives an injected fetcher returning local synthetic Stripe objects and the test checks live/test attribution. No real provider credential was identified. |

The original run `34086025661` reported the first five findings before the Stripe test was added. Its report reference was obtained, but the local transfer failed; conclusions above use the subsequent hosted locator-only log plus source review. The actual secret scanner was unavailable locally, so a Python approximation of its published rule patterns was used only to narrow investigation, never as the acceptance result.

`.gitleaks.toml` retains the complete built-in Gitleaks rules through `useDefault = true`. Each of its four exceptions requires both the exact anchored source path and exact anchored reviewed value, and is restricted to the reported rule ID. There are no commit exclusions, whole-file exemptions, blanket fixture directories or history rewrites. New values in these files, the same values in production files, and other detector rules remain in scope. The configuration is supplied explicitly by CI to pinned Gitleaks `v8.30.1`; findings continue to be fully redacted.

Validation completed locally: TOML parsing, four expected exception entries, retained default rules, exact positive matches and negative checks for a different source path or credential value. A successful hosted Gitleaks history scan is the final validation gate; local structural checks do not establish that result. None of the reviewed findings establishes a real exposed credential requiring rotation. Any subsequent distinct finding requires its own review and, if genuine, credential removal and rotation rather than another fixture exception.
