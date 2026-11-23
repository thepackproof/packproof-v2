# Controlled order journey

## One-click Windows warehouse lab (preferred for installed testing)

Open PowerShell in a checkout of this repository with Node.js 24 installed.
The wrapper creates a new, isolated `PackProof Exports ...` directory in your
**Documents** folder. Each order/picking/packing/shipping/etc. source has its
own directory and the Proof output directory is separate. No existing files
are overwritten.

```powershell
.\examples\multisource-journey\warehouse-lab.ps1 -Action Prepare
# Copy the returned "lab" path into the next command:
.\examples\multisource-journey\warehouse-lab.ps1 -Action Next -LabPath "C:\Users\YOU\Documents\PackProof Exports ..."
# After the first order is visible in an approved PackProof workspace:
.\examples\multisource-journey\warehouse-lab.ps1 -Action Run -LabPath "C:\Users\YOU\Documents\PackProof Exports ..." -DelaySeconds 5
.\examples\multisource-journey\warehouse-lab.ps1 -Action Status -LabPath "C:\Users\YOU\Documents\PackProof Exports ..."
```

Start with the empty source folders, approve the sources with the **actual**
browser/collector permission workflow, then publish events one by one.
Watch the same order's Proof ID persist while revisions, source records and
delivery events arrive. Some XML/media source formats still require manual
source selection; recognizing a folder is not proof of a successful connection.
Follow the **Packaged acceptance** checklist below to verify backend receipts,
late corrections, restarts, outages and local export hashes.

To test the wrapper without a PackProof account or backend, run
`.\examples\multisource-journey\warehouse-lab.ps1 -Action SelfTest`.
That only verifies disposable test file generation and publication. It cannot
qualify the Windows application itself.


Run from the repository root. The fixture exporter creates a new sample directory under the selected parent. The source folders and output folder start empty. The journal records publication time, source role, original size and SHA-256 for each step. Keep this operation in an isolated test tenant with no customer credentials.

~~~powershell
node examples/multisource-journey/journey.mjs self-check
node examples/multisource-journey/journey.mjs prepare .
$sample = 'COPY THE RETURNED SAMPLE DIRECTORY HERE'
node examples/multisource-journey/journey.mjs next $sample
node examples/multisource-journey/journey.mjs run $sample
node examples/multisource-journey/journey.mjs expect $sample
~~~

Connect the source directories with the corresponding roles and select the separate output directory. Use **next** at each acceptance checkpoint. **run** publishes all remaining inputs in order. Closing and reopening the CLI resumes from the journal. A failed event delivery can be retried with the same idempotency key. If the CLI was forcibly terminated, confirm no sample runner is active before removing only its runner.lock file. For event-driven order transport set PACKPROOF_SAMPLE_EVENT_URL to your loopback test adapter. It receives the sales order as JSON, a stable sample-operation header and an idempotency key. The remaining inputs continue through the separate physical folders.

Available variants are standard, reordered, burst, consolidated and cancelled. Supply the variant after the parent directory in the prepare command. Reordered publishes detached evidence before the order. Burst publishes eight deterministic replays. Consolidated adds a second order sharing a shipment, then a return of one item from the first order. Cancelled changes the remaining line quantity with a distinct source version.

The core order is SO10482 with two lines of A100. WO771 identifies the warehouse task. SHP771 and PKG92 carry the two units on line 20. SHP772 and PKG93 carry the single unit on line 30. Labels alone record no dispatch. The corrected order requests three units on line 20 while two have shipped. The photo sidecar explicitly refers to its original bytes by SHA-256. Alternate XLSX and text/image-only PDF specimens stay in the fixture directory. Include them independently when testing their reader lanes.

Run **other-owner** only for the isolation case. It writes the same displayed order number into a separate, otherwise empty directory. Connect that directory only to a different isolated sample tenant or owner. Assert that neither tenant can read the other's proof.

## Packaged acceptance

1. Install the candidate on an isolated Windows 11 machine and keep setup open. Choose the empty sample sources, reuse the order folder for another role and exit halfway. Reopen the application. Verify the same folders and roles appear. Finish setup and approve the operation in its browser session.
2. Publish each input and compare the first online proof, later revisions and per-line quantities to fixtures/expected.json. Record source publication, durable commit, screen display and export completion timestamps independently. Save each detail response from the backend, including the proof ID and revision. Confirm both desktop and web display that revision.
3. Stop the dashboard, publish another input, and check online acceptance. Reboot Windows. Confirm the service resumes automatically, consumes the remaining files and preserves authorization and source IDs. During collection disconnect an approved test share, publish to the unavailable source from its producer, reconnect it, and confirm the checkpoint scan admits the missing change. For an incomplete file, write to a temporary name first and publish the complete file by rename.
4. Take the disposable output share offline after a completed export. Publish a correction, retain the prior completed copy and confirm the online proof advances. Restore the share and wait for the pending output to settle. Compare the independently saved online response with the local manifest, file hashes, line allocations and current pointer.

~~~powershell
node examples/multisource-journey/verify-output.mjs "$sample/output" online-detail.json
~~~

The Windows candidate workflow also starts a disposable HTTP server with an isolated database, enrolls a test collector and drives a real C# worker with a scoped operator approval. It verifies the first order, its late evidence, split shipments, a correction during an output outage, worker restart, and the original label in the recovered output. The Windows job records the timings in http-journey-result.json. Separately, the workflow runs the fixture integrity check, sends the actual C# reader receipts to the backend projection assertion, exercises shared sources and setup recovery through the packaged service, and captures both themes from the packaged renderer using synthetic IPC. The workflow publishes its screenshots, layout assertions, checksums and native receipts. Actual OS reboot, user completion without coaching, real browser authorization, external system qualification and production deployment require independent observations.
