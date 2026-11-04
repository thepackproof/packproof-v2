# Setup and recovery guide

Start in the records workspace and keep the affected record, import receipt, or connection visible while following its next action. Record status describes what is known about a shipment. Connection health describes whether its source is being synchronized. A successful file check means the bytes match; it does not establish that the recorded scene or shipment was correct.

| What you see | Meaning | Next action |
| --- | --- | --- |
| Waiting for activation | The organization entitlement or released feature cohort is pending. | Have the workspace administrator check activation; keep the setup receipt. |
| Waiting for administrator | The source requires an authorized account owner. | Resume the saved setup with that administrator. |
| Row needs a reference | A shipment or order cannot be identified safely. | Select the correct reference column or repair the row; preserve leading zeros. |
| Ambiguous date or time zone | The file cannot be interpreted without an explicit choice. | Confirm source location time zone and the date mapping before importing. |
| Some rows imported | Successful rows have durable outcomes; others need repair. | Review failed rows and retry the corrected subset. Preserve the source identity of previous successes. |
| Duplicate | That source shipment identity is already recorded with matching input. | Open the existing record. Reimporting is not a new shipment. |
| Source conflict | The same source identity arrived with changed content. | Inspect both receipts and append an authorized correction; do not erase the first input. |
| Missing evidence | A due requirement is not yet established. | Obtain the indicated evidence or request an authorized waiver with a reason. This alone does not prove a loss. |
| Not yet due | The requirement's triggering stage or grace period has not occurred. | Continue the workflow; do not treat it as an evidence failure. |
| Action needed | Source access, mapping, or permissions need intervention. | Follow the specific reconnect or mapping action. Authorization alone does not prove data is current. |
| Freshness unknown | Available source signals cannot establish synchronization freshness. | Inspect receipt and source timestamps. Do not interpret this as healthy synchronization. |
| Continuous sync not applicable | The record came from a historical or one-time file. | View the import date; choose a separately supported ongoing source if required. |
| Snapshot pending | Preservation or signing has not completed. | Keep the operation receipt and recheck. Do not describe the snapshot as verified. |
| File mismatch | Stored/exported bytes do not match the referenced digest or byte count. | Stop relying on the affected artifact and report its ID and verifier result. Preserve the package for investigation. |

## Developer errors

| Status | Recovery |
| --- | --- |
| 401 | Renew the credential or human session through its supported flow. |
| 403 / private 404 | Recheck current organization, environment, membership and delegation. Do not probe another tenant's identifiers. |
| 409 | Reconcile the existing source identity or command key. Use a deliberate correction when data changed. |
| 410 | Resynchronize authorized snapshots, restart the committed feed and deduplicate immutable event IDs. |
| 412 | Refresh current state, show the intervening changes, then deliberately submit the new expected revision. |
| 413 / validation error | Reduce input to documented caps or repair highlighted fields before a new preview. |
| 429 | Follow Retry-After and reduce concurrency. Retain the exact command key while retrying. |
| 503 before acceptance | Retry safely with the same key; no durable acceptance has been confirmed. |
| Accepted operation with failed items | Read and repair the recorded item outcomes. A 202 receipt is not a claim that all evidence passed. |

## A useful support request

Include the workspace/environment, API request ID, operation/import/record ID, time and time zone, visible error code, expected action, and the nonsecret steps that reproduce it. State whether a command returned a durable receipt. Share only the minimum authorized source example needed to reproduce a mapping problem.

Never include bearer credentials, API keys, webhook secrets, signed media URLs, private evidence bytes, or full addresses in a diagnostic log or ordinary support ticket. A support bundle must list its contents before an authorized person shares it. Source access and connector capability validation require an actual authorized provider account, source examples, named maintenance owner, and a recovery test; a provider logo or successful login alone is insufficient.

For operating procedures and external acceptance gates, see [OPERATIONS.md](OPERATIONS.md) and [RELEASE_GATES.md](RELEASE_GATES.md).
