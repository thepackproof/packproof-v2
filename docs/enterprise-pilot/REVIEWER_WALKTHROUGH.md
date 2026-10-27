# Reviewer walkthrough

## Synthetic demonstration

1. In an isolated pilot environment, sign in with an enabled merchant organization administrator. Open `/enterprise` (the account shortcut is shown when the web enterprise flag is enabled).
2. Create a synthetic site with explicit retention days and one fulfillment mode, or select a site to which you have been granted access.
3. Choose **Load synthetic examples**. This uses the actual preview/import pipeline and stores synthetic source originals and illustrative PDF tickets.
4. Open **SYNTH-NORMAL**. Ordered, picked, loaded and acknowledged quantities are 10 EA. Inspect a source event and open its original ticket. The record remains a source assertion, not PackProof-attested delivery.
5. Open **SYNTH-SPLIT**. Two lines are fulfilled across two releases. Line 1 is 4 + 6 = 10 EA; line 2 is 8 + 12 = 20 EA. Confirm neither release overwrites the other.
6. Open **SYNTH-VARIANCE**. The source says 10 EA picked and 8 EA loaded; no line-scoped acknowledgment is available. Read the cited discrepancy and **Unknown** acknowledgment. Do not assign fault or infer where two units went.
7. Open a source record. Compare raw fields, normalized assertion and manifest metadata. Download an exact original if your role permits the source-export route.
8. Append an explanation or follow-up note. Imported facts remain immutable and exceptions are retained.
9. In **Sources & review queue**, inspect the ambiguous synthetic row. An authorized reviewer may select a source-supported dossier and record the reason. This records an association decision only.
10. Export a case summary. It contains source citations and its own digest; it does not certify upstream fulfillment.

## Source import

An administrator registers an approved source and an immutable field mapping with an approval reference. An importer selects that version, chooses the exact CSV/JSON export and optional original documents, reviews preview counts/quarantine and commits the reviewed import. Files remain labeled synthetic or historical according to the site mode. Document keys are exact filenames in the upload form.

Use corrected native revisions instead of editing imported data. Replay unresolved valid records after their prerequisites arrive. Invalid mandatory fields or unsupported source semantics need a corrected export or new mapping and explicit source correction.

## Measured pilot review

Before real evaluation, agree the cohort, question, complexity groups, available originals and correct answer with the site SME. Do not begin with an unvalidated savings target.

From a dossier, expand **Pilot review measurement**. Enter the same agreed study/question and choose baseline or PackProof conditions. Start timing before doing the task. Record completion, adjudicated correct/total links, known missing records made visible, and feedback. The server measures elapsed time, including pauses.

The evaluation screen reports sample sizes, medians/p90 by complexity and condition, and valid paired comparisons. Zero adjudicated or missing-record denominators remain unmeasured. Synthetic practices never become Winsupply performance claims. A partner reviewer must sign off on semantic accuracy and practical usefulness.
