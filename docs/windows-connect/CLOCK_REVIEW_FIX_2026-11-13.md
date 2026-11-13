# Clock and stage-correct review repair

The operator's screenshots showed a local sample preview, CLOCK_UNCERTAIN, an incomplete configuration, and an enabled Review in browser action. The browser itself was not available to this investigation, so the exact post-login navigation on that PC is not asserted.

Confirmed source defects:
1. HTTP Date was stored as a fixed instant and compared with DateTimeOffset.UtcNow later. More than five minutes without a new dated response could become a false clock error, and the pre-heartbeat check could prevent recovery.
2. A redeemed enrollment locator remained in LocalState.ApprovalPath. The configuration-stage review button was enabled by any nonempty approvalPath, even when no configuration had been submitted.
3. A successful heartbeat did not clear a resolved CLOCK_UNCERTAIN warning.

Repair:
- Project observed server time using TimeProvider's monotonic timestamp. Preserve the genuine five-minute drift and policy-clock rollback safeguards. Missing Date does not erase a known observation.
- Clear only CLOCK_UNCERTAIN after a fresh dated, successful heartbeat passes the clock check. Do not clear other errors or resume automatic collection.
- Status exposes only a pending enrollment or current installation/configuration/import review locator. No configuration means no review locator, which disables the existing configuration review button.
- Desktop review resolution independently derives the current stage and IDs rather than trusting a stale enrollment/import path.
- Request configuration approval now opens the saved request automatically. Failed submission cannot open an old link. Browser-open failure keeps the saved proposal and displays recovery guidance.
- Regression coverage includes idle intervals, genuine clock edits, missing Date, saved-warning recovery, preservation of pause state, stale enrollment/receipt links, failed submission, browser-open failure and the shared web post-login locator contract.

No credentials, approval grants, cloud records, shipment originals, queue keys or source permissions are changed by this repair. No web or backend deployment is made. Hosted approval compatibility and existing native storage repair gates remain enabled. Actual Windows 11 interactive login/import acceptance is separate from unit/native test success. Record run IDs and artifact hashes only after those outputs are observed.
