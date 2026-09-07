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

## Subsequent exact-source scan

Hosted run `34091018206`, job `101644328180`, at remote source `d80a6ea4583f10e496f1109514d0a3fc0812c424` reported seven new `generic-api-key` findings in `docs/program-2026-09-07/acceptance-evidence-register.v1.json`. The earlier six findings were absent, confirming the original targeted exceptions were applied.

| Line | Reviewed content | Evidence and scope |
| --- | --- | --- |
| 1630 | Prose listing five signing-key trust states | Ordinary status terminology in `implementedBehavior`; one exact value exception limited to the register and the generic rule. |
| 2669 | Digest of `backend/migrations/044_support_access.sql` | SHA-256 recomputed from the named tracked file and matched exactly. |
| 2690 | Digest of `backend/src/domain/access-links.ts` | SHA-256 recomputed from the named tracked file and matched exactly. |
| 2705 | Digest of `backend/src/domain/proof-access.ts` | SHA-256 recomputed from the named tracked file and matched exactly. |
| 2725 | Digest of `backend/src/support/access.ts` | SHA-256 recomputed from the named tracked file and matched exactly. |
| 2735 | Digest of `backend/tests/database-credential-rotation.test.ts` | SHA-256 recomputed from the named tracked file and matched exactly. |
| 2768 | Digest of `backend/tests/support-access.test.ts` | SHA-256 recomputed from the named tracked file and matched exactly. |

The six digest exceptions match the exact reviewed checksum, within this one register file and detector rule. They do not accept arbitrary hexadecimal strings or future digest values. The scan's keyword matching interpreted access/credential words in the inventory keys as credential labels. Two additional allowlist entries cover these seven findings, preserving the original four entries and all built-in rules. No source history was rewritten and no genuine credential was identified.

Local validation parsed the final TOML, recomputed all six checksums, and passed 39 positive/negative scope checks, including changed values, changed inventory keys, another source file, and extra trailing credential material. The cached official `v8.30.1` generic rule also reproduced all seven reported matches. The actual Gitleaks binary remains unavailable locally; the subsequent hosted scan is still the final acceptance gate.

Hosted follow-up run `34091473688`, job `101645707671`, accepted the prose exception but still reported the same six historical checksums. Its detector line representation did not match the full-JSON-line patterns assumed by the local simulation. Those six exceptions now use `regexTarget = "secret"` and six exact anchored 64-character values, retaining the `AND` condition, exact register path and `generic-api-key` rule restriction. All six source checksums were recomputed again; 14 positive/negative checks validate exact values, changed values, and source path restrictions. This correction changes matching semantics only; the reviewed values remain the same non-secrets. Hosted success remains unconfirmed until the next scan.
