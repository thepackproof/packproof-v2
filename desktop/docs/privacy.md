# Desktop privacy and retention review

Reviewed September 27, 2026 against the desktop implementation. This is a
code-to-disclosure review, not legal certification or evidence that a policy has
been published. The public policy source is
[`web/src/legal/documents.ts`](../../web/src/legal/documents.ts), including the
desktop section. Publication and release acceptance remain separate actions.

The published [privacy page](https://thepackproof.com/privacy/) was inspected on
that date. It displayed the September 8 policy, omitted desktop behavior, and
still showed its existing company/contact placeholders. The scoped source update
adds desktop disclosures and clarifies the distinction between marketplace OAuth
credentials and locally retained PackProof sign-in tokens. It sets the privacy
contact to `admin@thepackproof.com`, the service contact confirmed by the owner,
and preserves unrelated provisions and the unresolved legal-entity/address fields.

## Data and controls

| Data or operation | Actual behavior and destination | Source |
|---|---|---|
| Camera and optional microphone | Opening Packing Station starts selected-device preview after OS permission. Audio defaults off; enabling it also opens microphone input during preview. Only a started recording stages media. Tracks stop on leaving the view or quitting. Finishing a recording leaves the preview available for the next shipment; hiding the window in the tray does not itself stop that preview. | `src/renderer/PackingStation.tsx`, `src/main/index.ts` |
| Barcode observations | Bundled recognition runs locally. Submitted metadata includes detected values, formats, offsets and confirmation/other-package decisions. The original video can itself contain people, voices, addresses and labels. | `src/renderer/PackingStation.tsx`, `src/main/evidence/engine.ts`, `src/main/evidence-api.ts` |
| Sign-in | Password is sent to Cognito and is not persisted by this client. Tokens and profile are persisted in OS-protected encrypted storage. Sign-out clears that session. | `src/main/auth.ts`, `src/main/secure-store.ts` |
| Settings and cached records | Selected device IDs, recording preferences, retention, theme and notification settings persist; account-scoped Proof, order and integration caches support offline reads. These records use OS-protected encrypted vault files and do not currently have automatic age-based deletion. | `src/main/index.ts`, `src/main/secure-store.ts` |
| Original staging | AES-256-GCM protects chunks and journals. Each account has derived keys and opaque account-directory names; the installation key is stored through OS-protected encryption. The app does not regenerate a missing key over an existing queue. | `src/main/evidence/store.ts`, `src/main/secure-store.ts` |
| Server capture context | Submission sends account/Proof association, original bytes/size/hash, declaration and detections, random installation ID, version, OS family, camera label, capture timestamps and offline flag. These device/time claims remain client-reported. The installation ID is stable in that retained app profile; it is not a verified hardware identifier. | `src/main/evidence-api.ts`, `src/main/evidence/engine.ts`, `../../docs/DESKTOP_CAPTURE_CONTRACT.md` |
| Background work | The app can keep authenticated queue processing and workspace-status polling running in the tray/menu bar. Quit stops the process. Different signed-in accounts cannot view or resume each other's jobs through the app. Offline capture does not guarantee later server authorization or allowance. | `src/main/index.ts`, `src/main/evidence/engine.ts`, `src/main/workspace-notifications.ts` |
| Sharing | Current server preview and unchecked explicit consent authorize original recordings and future updates. Native review state is bound to account/epoch/Proof/hash and expires in ten minutes. Link expiry choices are 1, 7 or 30 days. Revocation cannot recall recipient copies. | `src/renderer/ShareProof.tsx`, `src/main/share-review.ts`, `src/main/security.ts` |
| Native notices | Fixed generic notices for queue, attention, synchronization, connectivity and updates contain no shipment/account content. The desktop-notification setting controls OS notices. | `src/main/workspace-notifications.ts`, `src/main/index.ts` |
| Updates | Configured packaged staging/production releases check a dedicated feed on startup; download/install is requested by the user. Update requests do not include PackProof credentials or evidence; the distribution provider sees ordinary connection and update-request metadata. | `src/main/updates.ts`, `src/main/index.ts` |

OS-protected encryption has platform limits. Electron uses macOS Keychain and
Windows DPAPI; Windows protection does not isolate data from other applications
running as the same OS user. This is not a promise of protection from a
compromised account or administrator, and files users export have separate access
controls. See Electron's [safeStorage documentation](https://www.electronjs.org/docs/latest/api/safe-storage).

## Local retention is not complete data erasure

`EvidenceEngine.cleanup()` removes media chunks only when the job is COMPLETE,
the exact size/hash commit receipt has been confirmed, and the retention interval
has elapsed. COMPLETE also requires successful attestation/finalization. The
retention clock starts at `confirmedAt` (commit confirmation), not at the later
finalization time. Choices are 0, 24 (default), or 168 hours. Cleanup runs through
queue processing for the signed-in account; closing the app, signing out, pausing
processing, or switching accounts can delay cleanup.

Pending, failed and interrupted originals are not automatically age-deleted.
The owner's explicit discard action removes eligible local media after a native
confirmation; already committed evidence cannot be discarded through this action.
The app attempts remote pending-upload cancellation when possible, but local
discard is not a guarantee that remote state or bytes were deleted.

Both cleanup and discard leave the encrypted job journal, including account/Proof
associations, capture context and progress/receipt history. Cached records also
remain. Logout removes the saved session, not the retained queue/cache. Installers
preserve application data during upgrades and uninstall. There is currently no
complete local-data erasure control; do not describe retention settings,
uninstall, or account-deletion requests as an immediate wipe of this computer.
Removing the protected key while recoverable evidence remains would make those
originals unreadable and is not a cleanup procedure.

Proof ZIP exports and diagnostic JSON files are saved to a user-selected path
outside the encrypted queue. They are not encrypted by the queue, not removed by
queue retention, and can be copied/backed up by other software. Users control
those copies. Server retention remains governed by the separate service policy.

## Diagnostics and centralized reports

Local logs contain coded events, timestamps, app version and OS family. They are
ordinary application-data files, not encrypted queue journals. Rotation retains
the current log and previous log, with rotation around one MiB rather than a
time-based expiry. Diagnostic export adds architecture, environment,
configuration/connection/secure-storage state, available/staged byte counts,
unreadable-job count, updater/reporting state and the latest 100 coded entries.
It does not export identifiers or recording contents.

The optional runtime Sentry client is automatic when a valid destination is
configured in a staging/production build. Development disables sending. Production
distribution requirements and delivery evidence are defined in
[RELEASING.md](RELEASING.md) and [error-reporting.md](error-reporting.md).
The app has a reporting-status display, not a separate telemetry-consent toggle;
disabling desktop notifications does not disable reports.

The final event scrubber permits fixed category/code, release version, channel,
OS family and random event ID. It excludes account/Proof/order/tracking/device
identifiers, camera labels, installation ID, free-form errors, stacks, file paths,
HTTP bodies/headers, tokens, media, attachments, session replay and tracing.
Duplicate codes are limited to once per minute per process. SDK envelope/transport
metadata can include event/send time and SDK identification. The receiving
service necessarily observes connection metadata such as source IP address;
payload filtering must not be described as complete anonymity or absence of all
personal-data processing.

The PackProof-owned project's actual region, retention, access controls and
processing terms must be recorded from its configuration. Do not invent those
values from the DSN or claim delivery/filtering was verified from compilation.

## Remaining publication and acceptance work

- Fill the existing `[LEGAL ENTITY NAME — developer review]` and
  `[MAILING ADDRESS — developer review]` fields with PackProof's confirmed details.
  These are factual organization inputs that this repository and the published
  policy do not establish. The privacy contact is now `admin@thepackproof.com`.
  The responsible policy owner must confirm the business statements and
  applicable legal terms. This change does not alter the separate Terms' legal/
  support-contact or governing-law/venue placeholders.
- Publish the scoped policy update through the website's current deployment
  baseline. Confirm the public `/privacy/` content and the app's privacy link;
  updating this repository does not update the public page.
- Record actual reporting destination, provider retention/access configuration and
  delivery/payload evidence for the production build. This review did not create
  a project, send telemetry, or inspect a private provider account.
- Attach the existing exact-release privacy acceptance result after checking the
  signed installed application: camera/audio permissions, retention/discard,
  account isolation, exported-file behavior and configured reporting. This review
  does not mark physical or signed-release acceptance passed.

No new legal requirement or additional approval mechanism is introduced here.
These items identify unresolved factual inputs, publication work and the privacy
acceptance already required by the development plan and release matrix.
