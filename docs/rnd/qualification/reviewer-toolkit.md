# Offline reviewer toolkit

The implementation lives in `research/qualification/reviewers/` and uses only the Python standard library. It reads local files, creates static browser packets and writes descriptive reports. It makes no network calls, changes no runtime feature flag, trains no model and never qualifies or publishes a result.

## Reproducible software dry run

From the repository root, use fresh output directories:

```sh
python research/qualification/reviewers/synthetic_demo.py --output /private/reviewer-demo-input
python research/qualification/reviewers/study.py prepare --manifest /private/reviewer-demo-input/manifest.json --assets /private/reviewer-demo-input --output /private/reviewer-demo-study
python research/qualification/reviewers/study.py score --key /private/reviewer-demo-study/coordinator/study-key.json --output /private/reviewer-demo-missing-responses.json
python -m unittest discover -s research/qualification/reviewers -p 'test_*.py' -v
```

Use corresponding absolute Windows paths when running on Windows. The dry run contains only marked synthetic text fixtures, four artificial cases and four anonymous packet tokens. The score with no response files is intentionally all NO_RESPONSE; it is a pipeline check, not an invented reviewer measurement. Open one packet's `review.html` to exercise the questionnaire manually. Browser timing and downloaded results from a software smoke test must remain labeled as such.

For real authorized inputs, copy the demonstration's **shape** to a new private manifest and replace all source paths, hashes, specimen/session IDs, reference annotations and policy values. Do not relabel the synthetic fixtures as real data. Start from [reviewer-manifest.template.json](reviewer-manifest.template.json) if you prefer an explicitly incomplete schema outline; it is deliberately invalid until populated.

```sh
python research/qualification/reviewers/study.py prepare --manifest /private/study/manifest.json --assets /private/study/assets --output /private/study/frozen-packets
python research/qualification/reviewers/study.py score --key /private/study/frozen-packets/coordinator/study-key.json --responses /private/returns/reviewer-a.json /private/returns/reviewer-b.json --output /private/study/analysis-v1.json
```

All outputs are created exclusively; existing files/directories are never overwritten. Preparation first validates the manifest and source bytes. A later copy/storage failure leaves an incomplete directory without a final preparation receipt; retain it as a failed attempt and prepare into a new directory. Do not distribute partial packets. POSIX output directories use mode 0700 and JSON files 0600; Windows relies on the private workspace's access controls. Keep the coordinator key and roster outside reviewer access.

## Input contract

- `schemaVersion` is `packproof.reviewer-study.v1`; `studyId` is an opaque code; `dataOrigin` is SYNTHETIC or CONSENTED_RESEARCH. Origin, consent, reference independence and pre-review freeze remain coordinator declarations, not software-verified facts.
- `policy` contains version, even reviewerCount from 4 to 64, private 64-hex seed, timeLimitSeconds, eventToleranceMs and frozenBeforeReview=true. Generate a real-study seed with `python -c "import secrets; print(secrets.token_hex(32))"` before assignment; retain it only with the coordinator. Archive the exact manifest's byte hash and the canonical `manifestDigest` printed in the receipt/key. They are different hash conventions and must not be interchanged.
- Each case names its feature (F03/F05), private stratum, train/tune/test split, and complete `specimenIds` and `captureSessionIds`. Include all shared carton, label, item and other prespecified physical grouping identities in specimenIds. Reused sources, sessions or specimen groups across splits are rejected. Related test cases are rejected rather than pretending that repeated presentation is independent. Combine the observation into one case or use a separate prespecified study; do not rename the same specimen to bypass the check.
- `originals` and `enrichment` each contain 1–8 local assets, with private slot, relative path, SHA-256, byteLength, mimeType and durationMs. Allowed types are MP4, PNG, JPEG, JSON and plain text. Files must stay within the supplied asset root; traversal and symlinks are rejected. No asset is recompressed or transformed. Slots become source-1/source-2 or support labels in reviewer packets.
- The maximum is 400 cases and 256 MiB per asset. JSON/text shown inline is bounded to 1 MiB. The default total copied-media budget is 2 GiB, across all packets; increase `--max-output-bytes` explicitly only after checking private disk capacity. The budget covers copied asset bytes, not HTML/JSON overhead. Each participant packet is self-contained, so source bytes may be copied several times.
- Each feature/stratum must contain an even number of test cases. With 12 reviewers, each case receives six original-only and six enriched assignments; every reviewer gets half of each stratum in each condition. Train/tune records participate in leakage validation but are not assigned or exposed as practice automatically.
- `question.target` uses one allowed event or channel. F03 reference values are OBSERVED, NOT_OBSERVED or NOT_ASSESSABLE. F05 values are OBSERVED_VALUES_EQUAL, OBSERVED_VALUES_DIFFER, MISSING_VALUE, CONFLICTING_VALUES or INCONCLUSIVE. No fraud/fault/authenticity/claim label is accepted.
- `reference` also contains RESOLVED/DISPUTED state, a conflict boolean, a frozen independent annotationDigest, and acceptableWindows. An observed F03 event needs one or more original-source windows with valid start/end times. Other responses require no window. The program verifies the supplied media bytes; it does not independently certify the annotation artifact or a person's annotation independence.

No reviewer names, emails or free-text notes are accepted in response files. Tokens are pseudonyms, not proof of anonymization: a private roster can still link them to people. Group reports omit reviewer tokens and expose only opaque case tokens, but strata and underlying media still need privacy review.

## Questionnaire and scoring

The static page has no external scripts, requests or persistent browser storage. Sources use relative packet files, text is rendered as text, and the page never shows the answer key or correctness feedback. It automatically records TIMEOUT at the frozen limit. Download progress after each task and verify the file exists; the page cannot silently write a durable file. Reloading loses unsaved local progress. Restrictive download or local-file browser settings may prevent use; treat that as a recorded technical issue rather than bypassing a browser control.

Responses are keyed to the exact study digest and reviewer assignment. Unknown fields, mismatched studies, foreign assignments, duplicate responses, nonfinite values and out-of-source time windows are rejected. The scorer re-derives assignment from the frozen key and rejects changes to the assignment table. It cannot authenticate a person's identity or attest an unmodified browser clock. Preserve the pre-study digest and external audit record to detect a replacement manifest/key.

| Output | Denominator and interpretation |
|---|---|
| Assigned/status counts | Every assigned task, including COMPLETE, ABSTAIN, TECHNICAL_FAILURE, TIMEOUT and NO_RESPONSE |
| Correct per assigned | Entire assigned population, with unresolved references separately reported; it is not accuracy among answered tasks |
| Correct per scorable assigned | All assignments with resolved reference annotations, including unanswered and failed tasks |
| Event correctness | Exact observation/conflict response plus accepted original source and both interval boundaries within frozen tolerance |
| Conflict detection | All assignments with a resolved conflict reference; unanswered tasks remain not detected; false conflict reports have a separate non-conflict denominator |
| Missingness recognition | All assignments whose resolved reference is MISSING_VALUE or NOT_ASSESSABLE, with exact-answer count |
| Median seconds correct-only | Success timing only; always read alongside completion and failure counts |
| Failure-penalized seconds | Correct response time; otherwise the frozen task limit, over all scorable assignments; a disclosed descriptive cost, not an inferred survival model |
| Brier/confidence bins | Only completed, reference-scorable responses; answeredScorable and bin n are explicit. Confidence means reference agreement, not physical truth |
| Reviewer agreement | Categorical observation/conflict agreement between reviewers of the same case and condition; assigned and answered pair counts both shown. Event-interval agreement is not claimed |
| Case contrasts | Difference in reference matches per assigned reviewer for each case; no p-value or independence claim |

The report deliberately gives no performance approval or final scientific threshold. Cases and reviewers are crossed repeated factors. The [protocol](reviewer-protocol.md) describes the separate analysis and external evidence still required.
