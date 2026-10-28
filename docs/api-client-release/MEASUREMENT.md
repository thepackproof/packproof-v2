# Metadata measurement runner

This prepared tool measures authenticated metadata GET requests at one exact HTTPS API origin. It does not create orders, record or attest evidence, export media, change permissions, or qualify provider/device/restore behavior.

Set credentials only in the server environment or secret manager used by the operator. Do not place them in command arguments, URLs, checked-in files, or receipts.

| Variable | Meaning |
|---|---|
| `PACKPROOF_API_ORIGIN` | Required exact HTTPS origin; paths, queries, fragments and URL credentials are rejected |
| `PACKPROOF_API_KEY` | Required existing server credential |
| `PACKPROOF_API_PROFILE` | `legacy` (default) or `partner` |
| `PACKPROOF_MERCHANT_ID` | Required partner merchant selector; sent as a header |
| `PACKPROOF_DELEGATION_ID` | Optional authorized partner delegation; sent as a header |
| `PACKPROOF_EXPECTED_SHA` | Recommended exact 40-character candidate commit; mismatch stops before authenticated reads |
| `PACKPROOF_MEASURE_PROOF_ID` | Optional existing Proof ID; otherwise the runner reads `/proofs/search?limit=10` |
| `PACKPROOF_MEASURE_REQUESTS` | 1–1,000; default 30 |
| `PACKPROOF_MEASURE_INTERVAL_MS` | Minimum time between request starts, 500–60,000; default 600 |
| `PACKPROOF_MEASURE_AGREED_RPM` | Agreed tenant budget, 1–120; default 100 |
| `PACKPROOF_MEASURE_CONCURRENCY` | 1–8; default one |
| `PACKPROOF_MEASURE_ALLOW_CONCURRENCY` | Must explicitly equal `true` for concurrency above one; an explicit agreed RPM is also required |
| `PACKPROOF_MEASURE_P95_MS` | Optional positive p95 threshold, for example 500; no threshold is implied when absent |

Run from the repository root:

```sh
node examples/api-client/measure.mjs
node --test examples/api-client/measure.test.mjs
```

The runner first reads public `/meta` without credentials, refuses candidate mismatch, then uses only authenticated GET requests on the selected profile. Redirects are refused. Every request has a 15-second deadline. Global start pacing is the slower of the configured interval and the agreed RPM, regardless of concurrency. The default is at most 100 tenant requests per minute; allow room for other clients using the same tenant budget. Any 401, 403 or 429 stops new work and aborts in-flight work. A 429 reports a bounded `Retry-After` value without retrying or increasing load.

The JSON receipt includes source environment/version/commit, the selected endpoint, bounded configuration, attempted and successful counts, status counts, transport/timeout/invalid-response failures, and nearest-rank p50/p95/p99. Successful-response latency and all-attempt latency are separate so failures cannot disappear behind a fast success percentile. Only aggregate response-body byte counts are retained; tokens and response payloads are never printed.

Exit status is zero for a complete successful sample, one for a missed optional p95 threshold, and two for incomplete/denied/rate-limited/failed qualification. The prepared tool and its deterministic tests are not a live HTTPS performance result.

The usage receipt supports a measured API/request and response-byte input to pilot cost accounting. It excludes TLS/header overhead, media upload/download, retained object versions, derived processing, provider charges, logs and backup costs. It does not calculate cloud prices or create billing entries. Record those additional measured quantities separately using the established usage ledger and exact candidate release evidence.
