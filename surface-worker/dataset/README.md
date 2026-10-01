# Physical corpus contract and blinded evaluation

No physical dataset is present. `manifest.empty.json` explicitly contains zero images and zero trials. Do not replace those zeros with synthetic imagery, a seed/demo result, or planned sample counts.

Collect Stage A's 240 physical labels (four print technologies × three media lots × two identical-content designs × ten separate physical copies), more than one printer unit per technology, and 60 carton surfaces across three classes with new/reused examples. Capture S24 Ultra→A16 and A16→S24 Ultra as separate strata. Add independent Android/iPhone devices. Record ordinary passive video, concurrent frames and coached close-ups separately. Only passive data addresses the no-extra-step hypothesis.

Keep ground-truth administrative marks outside all crops. Assigned identities do not belong to the image descriptor. A moved genuine label is `labelSame: true`, `cartonSame: false`, `assemblySame: false`. Reopening the same assembly is not necessarily visible to a surface matcher; closure and contents remain separate scenario metadata.

## Manifest format

Every capture entry requires:

```json
{
  "id": "capture-001",
  "split": "development",
  "synthetic": false,
  "acquisitionMode": "passive_video",
  "printProcess": "inkjet",
  "physicalPrintId": "physical-label-001",
  "labelSubstrateId": "label-paper-001",
  "cartonId": "carton-001",
  "assemblyId": "assembly-state-001",
  "shipmentLegId": "outbound",
  "designId": "design-a",
  "nominalContentId": "identical-tracking-and-label-content-a",
  "printerUnitId": "printer-inkjet-1",
  "mediaLotId": "label-lot-1",
  "captureSessionId": "capture-session-1",
  "operatorId": "operator-1",
  "deviceFamily": "samsung-s24-ultra",
  "capture": {"captureProfileId": "unqualified-profile", "acquisition": "live", "sources": [], "regions": []}
}
```

Populate capture.sources/regions/hints using the worker contract and measured pixel coordinates. The example is incomplete intentionally: no fake original digest or fixture is supplied. Store source-media checksums after capture and keep media in a private read-only tree. Optionally include observations such as lens, exposure, physical target scale, lighting, wear, days aged, resolution-target result, acquisition duration and temperature; keep unavailable values null.

The top-level dataset has schema `surface-dataset/1`, captures, pairs, and splitPolicy. Pairs are `{id,enrollmentId,observationId,split}`. Allowed splits: `development`, `validation`, `blind`, `domain_holdout`, `golden`. Physical print/substrate/carton IDs and exact source digests cannot cross splits. Add prescribed `splitPolicy.disjointDomains` from `designId`, `printerUnitId`, `mediaLotId`, `captureSessionId`, `operatorId`, `deviceFamily`. Physical components shared by multiple assemblies must remain in one split; splitting on assembly alone is insufficient. At least one same-content distinct-print pair is mandatory for a nonempty corpus.

Hold out selected domains entirely; a new domain should reject/abstain rather than silently count as supported. Golden synthetic or physical regression fixtures stay outside the locked scientific evaluation. Add Stage B's shipping, aging, wear, reprints, screen/printed replay, transferred labels, patch transplantation, occlusion, and media substitution only after an independently reviewed sampling plan.

## Freeze, score, then join truth

```sh
.venv/bin/python -m packproof_surface.dataset validate --manifest dataset/manifest.empty.json
.venv/bin/python -m packproof_surface.dataset freeze --manifest /private/manifest.json --output /private/freeze.json
.venv/bin/python -m packproof_surface.dataset score --manifest /private/manifest.json --freeze /private/freeze.json --media-root /private/media --split blind --output /private/predictions.json
.venv/bin/python -m packproof_surface.dataset report --predictions /private/predictions.json --truth /custodian/truth.json --output /private/report.json
```

Outputs refuse overwrites. Freeze commits dataset, executable inventory, profile, runtime, and each variant's experimental thresholds. The default thresholds are all null and decisions all inconclusive. To test proposed research thresholds, provide `freeze --thresholds /private/thresholds.json` before seeing the blind set. The object must have all variant keys, each null or `{differenceAtOrBelow,consistentAtOrAbove}` with values −1 to 1 and a nonzero abstention interval. This never enables application conclusions. Editing method files, profile, dependencies/runtime, dataset, or thresholds invalidates the freeze.

Variants: barcode_only (equality of pre-recorded nominal content, **not** an image-based physical identity feature), image_layout_only, print_residual, substrate_only, relationship_only (region placement), single_frame, multi_frame, complete_system. Complete-system diagnostics require all frozen coverage groups and conservatively use the minimum available print/carton residual. These are interpretable diagnostic baselines, not calibrated probabilistic fusion.

The independent truth custodian retains `surface-truth/1` separately. Scoring consumes no truth file. In a genuinely blinded run the model author must not have access to truth or recoverable physical IDs; have the custodian validate the identity manifest, create opaque capture IDs and scoring jobs, execute the locked scorer, and attest that separation. The software cannot enforce organizational blinding merely by putting files in different directories. Do not tune using the report and continue calling the same set blind.

Truth format:

```json
{
  "schemaVersion": "surface-truth/1",
  "datasetSha256": "digest-of-validated-manifest",
  "predictionsSha256": "digest-of-completed-predictions",
  "independenceReviewed": false,
  "pairs": [{"pairId": "pair-001", "labelSame": true, "cartonSame": false, "assemblySame": false, "attackFamily": "transferred-label", "independenceUnit": "predeclared-independent-trial-001", "independentTrial": false}]
}
```

A truth row is required for every prediction. Synthetic trials are counted separately and excluded from physical metrics. Reports include denominator-explicit whole-flow and conditional false findings, conclusive coverage, abstention, genuine success, and device/process/acquisition/attack strata. Wilson intervals are descriptive only when pairs are correlated. A one-sided zero-error bound is withheld unless the custodian explicitly reviews independence, trial IDs are unique, physical units are not reused across negative trials, and all required metadata is present. All-zero abstention cannot establish a low false-acceptance release claim. Even a computed small bound never auto-qualifies the application profile.

Required independent reports still include resolution/optics, passive enrollment failure, capture interruption/noninferiority, aging, attacks by family, per-job CPU/memory/latency, retries, storage/requests/transfer cost, reviewer comprehension, and final profile scope. AUC alone does not meet acceptance criteria. Raw correlations are private research measurements, not confidence percentages.
