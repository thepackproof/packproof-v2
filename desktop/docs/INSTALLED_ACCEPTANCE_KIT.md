# Installed-app acceptance kit

This kit gathers evidence for the exact candidate. It does not complete tests or
approve a release. Every gate starts **pending**. A failed, blocked, omitted or
emulated physical test is not a pass. The production publication gate stays in
place until the accountable reviewer has the required evidence.

## Prepare once

1. Download the final candidate artifacts for Windows x64, Intel Mac and Apple
   Silicon Mac. Extract each CI artifact into its own subdirectory; keep its
   installers, `release-evidence.json`, `SHA256SUMS` and native reports together.
2. From the matching source checkout run, substituting the exact 40-character
   commit and local paths:

   ```sh
   node desktop/scripts/prepare-acceptance-kit.cjs --source COMMIT --artifacts /path/to/candidate-artifacts --out /path/to/new-acceptance-kit
   ```

   The command streams and compares every installer hash/size, rejects mixed
   sources/channels/versions, and writes a candidate manifest, blank worksheet
   and acceptance report. It refuses to overwrite an existing kit. Missing
   platforms are listed, not treated as passed. No test, login or upload runs.
3. Assign one operator per platform and one final reviewer. Use clean dedicated
   QA machines: standard-user Windows 11 x64, supported Intel macOS, and supported
   Apple Silicon macOS. Record OS build, app version, installer SHA-256, camera and
   scanner models. Use an internal packing sample with no customer information.
4. Obtain authorized QA accounts, marketplace test orders, signed prior/current
   candidates and a controlled update feed from their owners. **Previously
   disabled acceptance accounts stay disabled.** Do not re-enable them or reuse
   retained credentials. Enter new operator-authorized credentials through the
   installed app; do not put them in worksheets or scripts. Missing prerequisites
   leave the affected test blocked/pending.

A development build can establish development behavior. It cannot establish
publisher trust, Gatekeeper acceptance, notarization or a signed production
update. Its synthetic queue sentinel is not a recording.

## What automation establishes

| Check | Scope of evidence |
|---|---|
| Source tests and Chromium fixture smoke | Error handling, schemas, local decoder and original streaming logic, renderer workflows. Chromium fake cameras and injected fixtures do not establish installed OS or hardware behavior. |
| Native CI startup/restart report | Real packaged main process, local renderer and sandboxed preload; independent readiness after each normal quit/relaunch; OS-protected installation material reopened without replacement. No account, real recording or queued evidence is used. |
| Windows installer smoke | Registered current-user installed executable and application bytes match the packaged candidate and launch/restart; same-version reinstall and uninstall preserve a synthetic sentinel and protected installation material. No earlier-version upgrade or real queue recovery is claimed. |
| macOS native CI | App in packaging output launches/restarts on native runners. This does not mount/install the DMG, establish clean-machine Gatekeeper trust or exercise physical cameras. |
| Controlled service acceptance, if separately recorded | The identified synthetic sample's backend upload/hash/commit/disclosure/revocation only. It does not establish a physical seller workflow. |

The new native harness must run successfully in final-source CI before its result
can be cited. Creating the harness or kit is not that result.

## Run the physical checklist

Perform the applicable behavior on **each** required OS/architecture. Record
separate outcomes if hardware or operating systems differ. The worksheet retains
all exact gate IDs; group the work below into one packing session to avoid
repeating setup.

| Session | Actions and observable pass criteria | Gate IDs |
|---|---|---|
| Install and identify | Verify the exact candidate hash and genuine expected publisher/signature. Install interactively as a standard user; test supported silent Windows install separately. On both Macs exercise DMG drag/install and Gatekeeper; exercise PKG when shipping it. Open the installed app and record its version. Later upgrade a genuine earlier version with real pending recordings; verify and preserve them after uninstall/reinstall. | `windows-install-upgrade-uninstall`, `macos-intel-install-upgrade`, `macos-arm-install-upgrade` |
| Identity and capture | Sign in, complete verification/reset using owner-approved QA accounts, exercise refresh/expiry, then sign out. Create pending evidence as account A; B must neither see nor upload A's queue. Return to A and recover it. Select built-in and USB cameras; test denied/re-enabled permission, occupied/removed device, microphone off/on and unplug during capture. The app must retain an interrupted original and never claim a completed recording. | `authentication-refresh-logout-isolation`, `camera-permissions-disconnect` |
| One shipment | Film the sample from item through packing, seal and readable label in one continuous recording. Require the explicit shipping statement. Play the committed original, compare duration/byte size/SHA-256 and manifest reference, and retry without duplicate evidence. Start the next order immediately. Review the actual sharing preview, confirm originals/future-update consent, check guest playback, then revoke the test link. | `continuous-recording-valid-media`, `hash-upload-commit-manifest` |
| Labels and orders | Present Code 128, QR, applicable UPC/EAN and Data Matrix labels to the actual camera. Verify duplicate suppression and deliberate wrong-label warning. Use a physical USB/Bluetooth keyboard scanner. Select authorized Shopify/eBay QA orders, compare canonical transaction identity and expected tracking, and sync without creating a duplicate Proof. | `live-barcode-and-usb-scanner`, `marketplace-orders-and-tracking` |
| Recovery | With real pending sample recordings, remove connectivity near 5% and 95%, restore it, quit/reopen, and force-close only the dedicated QA app. Reboot the QA machine and sleep/wake it. Exercise exhausted space only on a disposable QA disk/quota/VM, never by filling a personal system drive. Capture exact retained-job state and original-byte recovery after each failure. For expired upload authorization, let a known authorization expire under a controlled network interruption, restore service, and verify safe renewal without duplicates; never extract or publish signed URLs/tokens. | `offline-reconnect-and-restart`, `machine-restart-and-disk-full`, `expired-upload-authorization` |
| Update | From a genuinely signed older candidate, keep real pending recordings, install a correctly signed newer update, and verify queue recovery and exact original bytes. Offer the update during recording; capture must continue and restart must remain blocked until it finishes. Test wrong-publisher rejection on a disposable QA machine using a controlled invalid candidate. Do not weaken the app's signature checks. | `signed-updater-preserves-queue`, `capture-not-interrupted-by-update` |
| Workstation and shift | Use native 1080p, high-DPI/4K, 125–200% scaling, multiple monitors, keyboard-only operation, Windows screen reader/VoiceOver and reduced motion. Complete the actual planned packing shift with repeated capture/upload; sample resource usage at start/middle/end, verify camera release, bounded handles/memory/log growth, and review every failed/retained job. A short loop is not a shift. | `high-dpi-and-accessibility`, `recording-upload-soak` |
| Privacy and reporting | Compare actual camera/audio permissions, staging/retention, device metadata, exported diagnostics and reporting with current public disclosures. In the intended configured production monitoring project, locate an actual predefined sanitized event generated by the exact candidate; verify its release identity and payload exclusions. Configuration alone is insufficient. Never attach credentials, recordings, account identifiers or URLs to telemetry evidence. | `privacy-review`, `centralized-error-reporting-delivery` |

## Record evidence and close gates

For each worksheet row, record the operator, platform/build, exact artifact hash,
hardware, start/end time, actions, observed result and relative evidence filename.
Use synthetic labels/orders. Keep only necessary redacted screenshots, media/hash
receipts and diagnostic codes. Store private QA recordings separately under their
owner's access controls; reference them without placing them in the publication
bundle. Never copy the `Credentials` directory or installation key into evidence.

Mark individual observations `passed`, `failed`, `blocked` or `not run` in the
worksheet. Keep the machine-readable gate pending until its whole required
matrix has been reviewed. A reviewer then records concrete evidence references,
name and date in `release-acceptance.json`. Use the unchanged validator against
the exact source commit before giving the reviewed report to the protected
publication environment. The generator never sets an approval or pass.

A code change requires a new exact-source candidate and the applicable checks
again. Do not relabel an earlier report, substitute a successful compile for a
hardware test, or carry an unsigned result forward as a production-signing pass.
