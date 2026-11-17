# Shipment interpretation evaluation

From `backend`, run the following command on a local benchmark with exact UTF-8 CSV text. The runner uses the current production shipment parser and versioned field interpreter. It outputs counts, policy versions, a manifest SHA-256 and pseudonymous sample IDs. The diagnostic output omits cells and original headers.

```sh
node --import tsx scripts/evaluate-shipment-interpretations.ts tests/fixtures/shipment-evaluation-example.json 254663cec5e7f5823a515c387f58ca6a5414b195c0bfffe84c649550a01ad3f7
```

The checked-in example tests scoring on six synthetic files. For a warehouse evaluation, obtain authorized, deidentified examples and have a source owner label the report outcomes and each field's correct source column. Record the independent review under the manifest's pseudonymous `labelingReference`. Keep identifying information and the source-owner sign-off in the authorized site environment. Freeze the manifest digest and source-family partition before tuning, and give the digest to the runner on every scored run.

List all families used for development in `developmentFamilies`. All samples in `samples` are held out by exporter or source family. The runner rejects declared family overlap, exact copies of the shared development CSV corpus and duplicate evaluation originals or IDs. Accurate family membership and independent labeling require reviewer verification.

Each sample contains an ID, family, CSV text, expected outcome, and `expected.fields` mapping shipment fields to original header strings. Include every independently identifiable field, including fields on reports the system should abstain from processing. Supply all required fields on reports labeled automatic. The four outcomes are `automatic`, `needs_review`, `blocked` and `unsupported`.

| Report measure | Denominator and scope |
| --- | --- |
| Automatic field precision | Correct field bindings divided by all assignments on automatically admissible reports. No assignments produce a null result. |
| Field coverage | Ground-truth fields receiving an assignment on automatically admissible files divided by all labeled fields across offered files. |
| Automatic file coverage | Automatically admissible files divided by every offered file, including blocked and unsupported files. |
| Abstentions | Files without automatic admission, broken down by clarification, blocking and unsupported input. |
| Critical errors | Count unexpected automatic file admissions and wrong automatic shipment, tracking, location, quantity or source-time bindings. One sample may contain multiple errors. |

The runner exits with status 2 for any labeled discrepancy. It evaluates shipment interpretation and abstention. Comparisons, identity relationships across feeds, runtime approvals, backend availability and site rollout have separate gates.
