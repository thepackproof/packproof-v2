# Spreadsheet import

The records portal accepts a UTF-8 CSV with a stable shipment or order reference. A spreadsheet creates records once. It does not start a recurring connection or establish the physical condition of the shipment.

## Operator guide

1. Select the business workspace and environment that own the records.
2. Choose **Upload a spreadsheet**. Export Excel or other spreadsheet files as UTF-8 CSV first. The original file may contain at most 2 MiB, 1,000 data rows and 50 columns.
3. Choose the source location's time zone. Use a stable source name, such as `North warehouse shipment export`. Keep that same name when retrying a file or uploading corrected rows from that source.
4. Review the suggested columns. A shipment reference is required. Optional columns include description, quantity, tracking number, carrier, shipment date and an authorized location ID. Identifiers retain leading zeros. Quantities are whole numbers from 1 to 100,000; decimal conventions are never guessed.
5. Inspect the complete preview. **Valid**, **invalid**, **duplicate** and **ambiguous** rows are counted separately. Duplicate references with different details need review. Dates must use `YYYY-MM-DD`, or an ISO timestamp with an explicit offset, such as `2026-11-04T09:30:00-05:00`.
6. Fix errors before importing, or explicitly select **Import valid rows**. Download the row corrections file to see the original row number and remedy. Reupload the corrected subset using the same source name.
7. Keep the import receipt while processing. When processing finishes, open the resulting records. Previously accepted rows are retained if another row fails. Retrying the same receipt or the same source reference does not create another shipment.

If a previously imported source reference now contains different details, PackProof highlights a conflict. Review the existing record and append a correction through the authorized review workflow. An import never silently replaces an earlier assertion.

An administrator must activate the workspace before accepting imports. Review-only members cannot import. Location-limited members must identify an authorized location. A source or permission problem may require an administrator to restore access before retrying the receipt.

## Maintainer contract

The human-session router is mounted at `/me/records/imports` and requires the existing organization feature and current merchant workspace entitlement. Service credentials cannot be used as human import identities.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/template.csv` | Download a synthetic example with familiar headers. |
| GET | `/limits` | Import byte, row, column and encoding limits. |
| POST | `/preview` | Preserve original bytes, validate all rows and return a durable preview receipt. |
| GET | `/{id}` | Current authorized import state and row outcomes. |
| GET | `/{id}/corrections.csv` | Formula-safe failed-row correction download. |
| POST | `/{id}/commit` | Confirm the exact preview and queue processing; poll the receipt. |

Preview accepts `organizationId`, `environment`, `csv`, `timeZone`, optional `sourceName` and optional `mapping`. Mapping keys are `shipmentReference`, `itemTitle`, `quantity`, `trackingNumber`, `carrier`, `shippedAt` and `locationId`; each value is an exact header string. Commit accepts the returned string `previewVersion` and an explicit boolean `importValidRows`.

The source UTF-8 bytes, including any BOM, are preserved through the existing private committed-object storage path. A server-computed SHA-256 and byte count are compared with the stored object. Production acceptance requires an exact, non-null storage VersionId. The receipt binds the object version, source namespace, mapping version, time zone and complete row preview. Development memory stores are explicitly unversioned fixtures.

The committed job is a durable PostgreSQL inbox. `startRecordImportWorker` polls it with a renewable lease; expired leases are reclaimed. Every row rechecks the current workspace, human role and location before using the existing transaction and Proof creation services. Canonical changes, external source binding, tenant event association, operational projection, source audit and successful row result commit together. Existing Proof audit/outbox triggers feed the shared event stream.

Business deduplication is permanent within organization, environment, source namespace and shipment reference. It does not depend on a short-lived request cache. A changed payload under an existing reference is a conflict. Row outcomes survive worker restarts and retries. Failed rows may be retried through the same receipt up to five attempts; prior successes remain unchanged.

Source fields in receipts and normalized rows are immutable. Corrections create a new preview. The worker verifies the preserved source bytes before processing and exposes `action_needed` when the original is unavailable or fails integrity checking. Diagnostic errors contain no credentials or storage URLs.

Spreadsheet values are data. The parser does not evaluate formulas or markup. Correction downloads prefix formula-like values before quoting them, including values preceded by whitespace. Browser upload code must use fatal UTF-8 decoding and preserve any BOM rather than silently replacing malformed bytes.

Tests: `backend/tests/record-imports.test.ts` covers parsing, source preservation, human attribution, partial import, repeated/corrected inputs, source conflict, tenant/role/location/revocation boundaries, replay, stale-lease recovery, original tampering, immutable receipts and authenticated correction downloads. These deterministic tests do not establish nontechnical usability targets, live S3 policies, production throughput or restore readiness.
