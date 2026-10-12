# Offline intake commands and data format

Run with Python 3.12+ from the repository root. All writes are exclusive: choose a new output path; do not overwrite earlier protocol/evidence versions. The source tools use only the standard library. They neither upload files nor open devices, except for the separately invoked read-only `device_preflight.py`.

```powershell
python research/qualification/physical/intake.py prepare --output "C:/PackProofPrivate/preparation-v1"
python research/qualification/physical/intake.py pair-schedule --pairs 20 --seed 20261011 --output "C:/PackProofPrivate/paired-order-v1.json"
```

`prepare` produces four files: `protocol-template.json`, `session-intake-template.json`, `specimen-allocation-reference.csv`, and `preparation-receipt.json`. The CSV references the existing 240-label/60-carton plan; it does not create a second population or measured records. The blank protocol intentionally cannot freeze. A pair schedule is planned-only, balanced OFF-first/PASSIVE_ON-first order, and reproducible from its seed. Twenty pairs is a command example, not a recommended powered sample size. Copy chosen schedule fields into a reviewed comparison protocol before freezing; freeze the condition, duration/cooldown, detail-count and reviewer procedures in its review artifact. Do not reshuffle after seeing results.

## Complete and freeze a protocol

Copy the template to `protocol.json` within your private study folder. Fill every blank. Valid study types are `STAGE0_PASSIVE`, `F01_OPTICAL`, `F01_SECURITY`, `F04_METROLOGY`, `F06_REPLAY`, and `F08_PASSIVE_COMPARISON`. There is no active-control study mode. Physical records use `dataOrigin: "physical-consented"`; software fixtures use `"synthetic-fixture"`. The string is a declaration, not proof of physical collection or consent authority.

Each artifact is an explicitly named relative local path with exact positive byte length and lowercase SHA-256. Use slash-separated paths; absolute, parent-traversal, linked/junction and Windows stream paths are rejected. Files may be at most 16 GiB each and metadata 10 MiB; larger media needs a separately reviewed storage flow, not splitting to manufacture independent units. Do not include raw names/addresses in IDs or the shared report. An artifact example, with deliberately invalid placeholders, is:

```json
{"path":"private/consent.pdf","byteLength":0,"sha256":"REPLACE_WITH_ACTUAL_64_HEX_SHA256"}
```

Use the PC's file hash tool to measure real bytes; never fill a made-up hash or length. `artifacts` is a map of pseudonymous artifact IDs to these records. `protocolReviewArtifactId` must refer to one of them; each operator's `consentArtifactId` must also resolve. Retain the consent review, safety limitations, metric definitions, independent ground-truth procedures and permitted use in the protocol-review document. The tool checks bytes, not document meaning or signatures.

Each device requires a pseudonymous `deviceId`, model, exact `osBuild`, 64-hex `appBuildSha256`, and nonempty `nativeStreamProfile`. Each planned acquisition requires `attemptId`, inventoried `deviceId`, consented `operatorId`, `physicalInstanceId`, `conditionId`, `variant`, `split`, and `captureMode`. Variants are `OFF` or `PASSIVE_ON`; Stage 0 permits only OFF and pilot split. Capture modes are `ORDINARY_CONTINUOUS_VIDEO`, `CONCURRENT_NATIVE_SELECTED_FRAME`, or `COACHED_LAB_CLOSEUP_SEPARATE`. A selected frame is retained as a derivative of its original session, not another independent trial.

F01/F04/F06 attempts additionally declare `attackFamily`. F01 attempts require `plannedLabelId` and `plannedCartonId` from the existing allocation reference with its unchanged split. Include the actual `labelId`, `cartonId`, `printRunId`, `materialLot`, `printerUnitId`, and applicable `attackDeviceId` to expose held-out design gaps. No hypothetical identifier counts as an actual inventory assignment. Stage 0 material can stay outside that frozen population.

F08 comparison attempts additionally have `pairId` and `position` 1 or 2. Each pair has exactly one OFF and one PASSIVE_ON acquisition; device/operator/physical instance/condition/split/capture mode must match. Add `comparison: {"expectedDetailsCount": N}` with the positive integer readability denominator chosen before collection. Include the review document's exact annotated detail list and blinded context rubric; a count alone does not define the task.

All controls must remain exactly:

```json
{"mode":"PASSIVE_ONLY","activeIllumination":false,"automaticFocus":false,"automaticExposure":false}
```

Set a timezone-qualified `retentionUntil`, retain `evaluationDataAccessed: false` only if true, then freeze:

```powershell
python research/qualification/physical/intake.py freeze --protocol "C:/PackProofPrivate/study/protocol.json" --private-root "C:/PackProofPrivate/study" --output "C:/PackProofPrivate/study/protocol.freeze.json"
```

The freeze receipt binds exact protocol bytes and review/consent/calibration artifact hashes. Even reformatting the protocol requires a new version and freeze. It is a local declaration, not an independent timestamp authority. The repository's two frozen JSON references use LF checkout rules so Windows and Linux bind identical bytes.

## Record acquisitions and inspect them

Use `session-intake-template.json`, set its `protocolSha256` from the freeze receipt, and append exactly one record per planned acquisition. Supported statuses are `RECORDED`, `FAILED`, `EXCLUDED`, `NOT_RUN`; every non-recorded status requires a reason. Missing planned attempts are counted as NOT_RUN. A failed/excluded attempt may retain a partial original under `source`; its bytes are still verified.

A RECORDED entry contains `attemptId`, `status`, `source` artifact, timezone-qualified `startedAt` and `endedAt` after the freeze, a pseudonymous `captureSessionId`, the actual `nativeStreamProfile`, the passive `controls` object, and integer `recordingInterruptions`. Keep interrupted recordings and their counts. Never copy one original into multiple attempt IDs. The tool does not decode media or verify that these metadata declarations match the file.

F04 entries also contain `metrology: {"unit":"mm","referenceMm":…, "reconstructedMm":…, "referenceUncertaintyMm":…, "calibrationArtifactId":"…"}`. Bind the calibration record in the protocol before collection. The report supplies absolute error, the existing proposed `max(5 mm, 2% of reference)` tolerance, and a conservative error-plus-reference-uncertainty comparison. This is not a full uncertainty budget or traceability/fitness determination. Keep repeated readings, instrument/method identity, dimension definitions, environmental records and evaluator method in the original lab artifact.

F08 entries contain `metrics` with `durationMs`, `batteryUsedPercentagePoints`, `peakMemoryMiB`, `peakTemperatureC`, `frameGapCount`, `droppedFrameCount`, `readableDetails`, and `totalDetails`. Counts must be integers; totalDetails must equal the frozen denominator. Record the temperature sensor, sampling interval, memory accounting, frame-gap threshold and battery measurement method in the review artifact. A device's battery sensor cannot silently substitute for processor temperature. USB charging can invalidate battery consumption comparison; retain that condition and mark affected evidence unavailable rather than inventing a delta. Require `decoderReport` and `blindedReview` artifact references per arm. The latter must include the predeclared context-preservation rubric as well as readable detail annotations. Missing evidence prevents a complete pair. The output gives descriptive PASSIVE_ON-minus-OFF deltas only, without significance or generalized benefit claims.

```powershell
python research/qualification/physical/intake.py validate --protocol "C:/PackProofPrivate/study/protocol.json" --freeze "C:/PackProofPrivate/study/protocol.freeze.json" --intake "C:/PackProofPrivate/study/session-intake.json" --private-root "C:/PackProofPrivate/study" --output "C:/PackProofPrivate/study/intake-report-v1.json"
```

A valid but incomplete intake exits successfully and reports `INCOMPLETE_OR_REVIEW_REQUIRED`. Structural/hash/protocol violations exit 2 without a success report. `INTAKE_COMPLETE_NOT_QUALIFIED` means only these bounded intake checks passed; `qualified` and `releaseEligible` are always false. Read the state and findings, not merely the exit code. Reports retain the entire planned denominator, unavailable pair arms, interruption observations and any missing/cross-split holdout identifiers. Same-device optical screening must not be fed to the existing evaluator as held-out-device validation. F01/F04/F06 statistical evaluation remains a separate, frozen-method step using the existing benchmark evaluator and genuinely independent units.
