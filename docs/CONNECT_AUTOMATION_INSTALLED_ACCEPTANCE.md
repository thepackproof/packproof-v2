# Installed Windows 11 shipment acceptance

Use a development-channel build from the reviewed commit, a sandbox workspace, and an authorized test computer. Record the exact installer SHA-256, Windows build, service version, API and worker image revisions, browser build, active rules and flags, and tester. Keep this record separate from CI evidence.

The Node helper publishes synthetic fixtures locally. It makes no requests, approvals or changes to the service. Supply a dedicated parent folder on local NTFS that the service can read. It creates a new test subfolder on the first step. Use the same run ID throughout. The example parent below must be replaced with the test computer's actual authorized path.

```powershell
$parent = 'C:\TestExports'
$run = [guid]::NewGuid().ToString('N')
$helper = '.\connect-windows\scripts\publish-acceptance-export.mjs'
node $helper publish $parent $run first
```

1. Record the service identity and the protected queue condition before testing. For upgrade qualification, begin with a supported earlier installation containing pending encrypted work. Reconcile its original bytes, receipt/key identities and progress after upgrade. Keep the original private test materials available.
2. Choose the generated subfolder in Connect and select `first.csv`. Compare the local reference, title, quantity and source time to the helper output. Check the isolated API/object-store audit for zero original uploads before source consent. Sign in via the current review, grant only the named configuration, and record when the exact original is first stored.
3. Authorize the specific initial batch separately. Retrieve the final import and its canonical Proof with the appropriate sandbox identity. Use the existing authorized import and Proof GET endpoints. Save their actual JSON responses, outside the watched directory. Run the check below. Record the distinct recurring-grant approval and confirm the installed collector acknowledges it.
4. Close the desktop application, leave the background service running, and publish the second fixture with `node $helper publish $parent $run ui-closed`. Observe collection from the portal. Save the authenticated responses and check them against `ui-closed.csv`. Record the file-publication and record-availability timestamps and the UI process state.
5. Reboot Windows, leave the desktop application closed, and repeat with the `after-reboot` phase. During an authorized transient-outage exercise, publish the `offline` phase within the approved offline window, then restore connectivity. Confirm recovery produces exactly one completed receipt/Proof for that fixture. Record source counts for the run, including blocked or duplicated work.
6. Exercise denial, expired authority and revocation separately. Confirm blocked intake in the audit trail and preserved local work. For the usability gate, observe all five participants and record assistance, interruptions, misunderstood permissions and elapsed time for each attempt.

```powershell
$file = Join-Path (Join-Path $parent "packproof-acceptance-$run") 'first.csv'
node $helper check $file 'C:\TestEvidence\first-receipt.json' 'C:\TestEvidence\first-proof.json'
```

Repeat the check for each phase with its own evidence pair. It checks exact file bytes, exhaustive one-row accounting, reference, quantity, time, canonical Proof and import event. Supplied JSON can be synthetic or stale. Preserve the authenticated retrieval trace and runtime manifest separately to establish where each response came from. The helper does not measure the Windows service, identity of the approving user, host restart, customer semantics, or independent usability.
