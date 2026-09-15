# Upload handoff and barcode feedback

Base: released upload-recovery source `4ca7c91750668dd51c35068d507779f3c50d3ba7`, Android 0.3.14 (43).
Candidate: Android 0.3.15 (44), branch `codex/upload-notifications-usps`.

## User-visible changes

- Ordinary seller submission returns to Home once the original, shipment confirmation and queue intent are saved. Upload and server finalization continue above screens. A second recording can prepare while the first upload is stalled.
- Home distinguishes queued, actively uploading, interrupted and saving work. Existing cards update in place without reordering the list during packing. Earlier upload completions cannot select an older Proof over a newer recording.
- Android displays an ongoing upload notification and a completion notification only after the server confirms the corresponding evidence is committed and the Proof finalized. A notification tap opens the corresponding Proof, deferring navigation while another recording/review is active.
- The newer identifier path restores immediate shipping-barcode haptics and an animated visual pulse. A read is described as a read; order conflicts and product/shipping ambiguity remain subject to server review. Repeated reads do not repeatedly vibrate.
- USPS IMpb framing (`]C1`, FNC1/group separator and supported ZIP/ZIP+4 routing prefixes) reaches the existing scoped shipping resolver. Product GS1 data remains separate. Saved-video inspection retains up to 1920 pixels on the longest edge to improve dense-barcode recovery, within the existing frame/time budget.
- Fresh uploads send the original file through native streaming to the existing server-issued admission endpoint. This removes JavaScript Base64 conversion, temporary chunk copies, sequential per-part requests and part assembly from the first upload. Existing/incomplete evidence continues using its resumable upload identity. Video quality and original bytes are unchanged.

## Integrity and operational behavior

The signed declaration still precedes upload. Only the backend commits/finalizes evidence. Receipt-based cleanup remains mandatory. Returning Home does not delete the original. Account/server checks remain in the retry owner. The production bounded admission gateway, quotas and content validation remain in use; this change does not enable unrestricted S3 uploads.

Notifications are device-generated Android notifications after authenticated server confirmation, not a new FCM/APNs server push integration. No new messaging provider or runtime service is required. Android notification denial does not block submissions. A bounded data-sync foreground service supports active transfers when the app loses the foreground; its wake lease is at most 15 minutes. Android force-stop terminates work; existing durable recovery resumes after reopening. Notification receipts avoid repeated completion alerts and recover a completion that was confirmed just before process shutdown.

## Validation and pending release work

Passed: 33 focused mobile tests covering queue handoff with a stalled first upload, resumable identity, completion timing, barcode feedback, framed USPS reads, recovery and missing-file handling. Passed: 57 focused backend tests covering shipping association, identifier classification and framed USPS input. Backend and mobile TypeScript checks passed. Metro/Hermes Android export passed. Patch whitespace checks passed.

Native Kotlin compilation, signed AAB generation, Android notification/lock-screen permission tests and S24 Ultra/A16 device acceptance are pending. No measured upload speed multiplier is asserted. Compare the same original and network before/after; confirm interrupted delivery still resumes with the same evidence identity. Check printed and screen-displayed labels separately; this source review cannot establish the cause of the reported single failed scan.

No API deployment, public GitHub publication or Play submission was performed. Automatic approval review rejected public GitHub branch publication, stating that implementation authorization did not include publishing/exporting to that public destination. The exact changes are retained privately for review. Obtain approval for public publication before retrying that action; do not bypass the rejection.

Release needs the backend parser change and a newly built Android binary; an over-the-air JavaScript update alone cannot install the notification service.

Sources checked: [ML Kit barcode input guidance](https://developers.google.com/ml-kit/vision/barcode-scanning/android), [Android data-sync foreground service](https://developer.android.com/develop/background-work/services/fgs/service-types#data-sync), [Android notification permission](https://developer.android.com/develop/ui/compose/notifications/notification-permission).
