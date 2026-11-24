# Controlled order journey

Run from the repository root. The fixture exporter creates a new sample directory under the selected parent. The source folders and output folder start empty. The journal records publication time, source role, original size and SHA-256 for each step. Keep this operation in an isolated test tenant with no customer credentials.

~~~powershell
node examples/multisource-journey/journey.mjs self-check
node examples/multisource-journey/journey.mjs prepare .
$sample = 'COPY THE RETURNED SAMPLE DIRECTORY HERE'
node examples/multisource-journey/journey.mjs next $sample
node examples/multisource-journey/journey.mjs run $sample
node examples/multisource-journey/journey.mjs expect $sample
~~~

Read each source directory using its corresponding role. Keep exported proofs in the separate output directory. Use **next** at each acceptance checkpoint. **run** publishes all remaining inputs in order. Closing and reopening the CLI resumes from the journal. A failed event delivery can be retried with the same idempotency key. If the CLI was forcibly terminated, confirm no sample runner is active before removing only its runner.lock file. For event-driven order transport set PACKPROOF_SAMPLE_EVENT_URL to your loopback test adapter. It receives the sales order as JSON, a stable sample-operation header and an idempotency key. The remaining inputs continue through the separate physical folders.

Available variants are standard, reordered, burst, consolidated and cancelled. Supply the variant after the parent directory in the prepare command. Reordered publishes detached evidence before the order. Burst publishes eight deterministic replays. Consolidated adds a second order sharing a shipment, then a return of one item from the first order. Cancelled changes the remaining line quantity with a distinct source version.

The core order is SO10482 with two lines of A100. WO771 identifies the warehouse task. SHP771 and PKG92 carry the two units on line 20. SHP772 and PKG93 carry the single unit on line 30. Labels alone record no dispatch. The corrected order requests three units on line 20 while two have shipped. The photo sidecar explicitly refers to its original bytes by SHA-256. Alternate XLSX and text/image-only PDF specimens stay in the fixture directory. Include them independently when testing their reader lanes.

Run **other-owner** only for the isolation case. It writes the same displayed order number into a separate, otherwise empty directory. Connect that directory only to a different isolated sample tenant or owner. Assert that neither tenant can read the other's proof.

## Verify an exported proof

Compare each proof revision and its line quantities to `fixtures/expected.json` as you submit the sample inputs through your test integration. To verify an export, save the corresponding backend detail response as `online-detail.json` and run the verifier against the output directory.

~~~powershell
node examples/multisource-journey/verify-output.mjs "$sample/output" online-detail.json
~~~
