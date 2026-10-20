# SIGNAL implementation review — 20 October 2026

The SIGNAL journey is integrated across web, Android, iOS and desktop on `feat/signal-ui`. Web and Android were implemented and built first; iOS and desktop followed. This is an internal review implementation, **not a verified production release**. Physical-device acceptance, installed-app screenshots and upgrade/rollback exercises have not been executed. No production application, backend or store release was published.

## Source and design baseline

| Item | Observed baseline |
| --- | --- |
| Repository | `thepackproof/packproof-v2` |
| Starting main commit | `bbcea01bdb8574da751125f35ad97ecc976f4dba` |
| Web/Android milestone | `01e6b61aed1592f0dd772dc76623cf3024c5b192` |
| All-platform implementation milestone | `575db6abbf224d1f9deac6f6a8dce7555e2e97c3` |
| Design | Figma `4AtxdZJxHvpWVF3cCX14Z0`; all 27 source node contexts/screenshots read on 20 October 2026 |
| Installed production app | Not observed; no attached physical device. Build numbers in configuration do not establish the installed version. |
| Live backend, read-only observation | `/health` returned `ok`; `/capabilities` reported commit `ccd04aba5b9305ce9bb7b2105323e63f6a95d87a`, version `1.0.2-production-ccd04aba` |
| Preservation capability | Receipt version 1; `durableReceiptsRequired: false` |
| Capture limits advertised by backend | 250,000,000 bytes, 300 seconds, two active uploads |

Backend URL: `https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws`. No backend source or contract was changed. No private Proofs were created for this work.

Dependency lockfile SHA-256 values remain unchanged:

| Lockfile | SHA-256 |
| --- | --- |
| mobile/package-lock.json | `c58566d4d55b4dce56781b30796281b5370aaf6c123a4b04b82c16e50a868af6` |
| web/package-lock.json | `310cbf7ce81348b8f0b251c2980fc74760358f4c845e73c62e9ebf3a1fb92107` |
| desktop/package-lock.json | `7a568223a93750137024b25b93401cf721d49629c77299afeb694676f1303b22` |

## Coverage and behavior

[coverage.json](coverage.json) maps every approved Figma node to its real state and platform source. `applicationScreenshot`, `fixture`, visual comparison and device acceptance are deliberately unset or marked not executed. Source design screenshots are not application screenshots. Desktop adapts the approved mobile journey to the existing workstation layout, as explicitly requested; it has no separate approved desktop frame.

The primary workspace is Home, Proofs and Activity. Existing orders, imports, integrations, grading, account, notifications and support remain accessible through secondary navigation. Item name leads to the guide, actual continuous capture, local review, the canonical seller declaration, the existing authorization flow, operation-specific upload progress, and a server-backed record. Search, filters, profile, overflow, leave/return, retake selection, playback, share and clipboard actions are connected to their existing owners. This is a source control audit; interaction acceptance is not yet recorded.

Original Figma parcel, sealed parcel, logo, navigation and chevron artwork is exported into platform assets. Space Grotesk Bold, Manrope and IBM Plex Mono Medium are bundled with their licenses. Semantic colors are defined in `mobile/src/theme/signal.ts` and `web/src/signal/signal.css`; desktop reuses web SIGNAL components and adds `desktop/src/renderer/signal.css`. The cobalt action color is `#3158D5`, canvas is `#F3F5F4`, ink is `#111916`, mint receipt is `#70E4C2`, and camera surface is `#18221F`. Orange remains artwork decoration. The initial appearance is light; an existing explicit appearance preference is retained.

Native capture continues to use the current camera, biometric, journal and upload owners. Browser capture continues to use MediaRecorder and its IndexedDB queue. Desktop retains its encrypted evidence engine and adds a durable unsubmitted `REVIEW` state, scoped local playback and explicit take selection. Interrupted or unplayable recordings are retained and cannot be submitted as a valid continuous take. Leaving upload progress does not create another submission owner.

“Saved to PackProof” requires the exact finalized Proof, committed evidence and matching evidence/finalization preservation receipts. A compatible backend response that finalizes without receipts is shown neutrally as received/finalized. It does not acquire a mint receipt by reaching 100%, waiting for a timer or copying a link. Desktop now also retains local originals while receipt confirmation is pending (`SUBMITTED`). Actual links use the existing privacy preview, authorization, explicit consent and expiry flow; copied feedback follows clipboard success.

## Local state and compatibility

Existing owner, account, environment, Proof, evidence and operation identities remain authoritative. New replacement metadata records the original and candidate identities and the durable decision. Choosing a replacement requires a playable, continuous candidate. The original stays retained until a valid explicit selection; failed candidates cannot silently replace it. Submission checks also block an original that has an unresolved or accepted replacement. No take is concatenated with another.

Web stores the protected original with its pending replacement and commits the choice in the existing IndexedDB transaction. Native persists the decision before updating the selected take. Desktop persists candidate/original relations in the encrypted journal; it retires selection without deleting either local file. Its new bounded local playback protocol is opaque, account-scoped and revoked on session changes. New optional journal timestamps are used only when real timestamps exist.

Desktop journals formerly marked `COMPLETE` without a durable-confirmation marker are rechecked as `SUBMITTED`; this cannot restore files already removed by an older version. UI retention wording checks actual local-copy availability. Unknown/damaged journals continue through the existing recovery/error paths; no destructive schema migration was introduced.

**Rollback policy:** use a compatible forward fix while any new review, replacement or confirmation-pending journals exist. Older binaries do not understand all new metadata and desktop states. Do not promise a safe binary downgrade or disable the desktop presentation while new review journals are pending. A same-binary presentation flag retains the updated owners, but its rollback behavior has not been exercised on a device. Existing release documentation and signing controls still apply. Installed-build upgrade and rollback remain open acceptance gates.

## Build and activation

`EXPO_PUBLIC_PACKPROOF_SIGNAL` (native) and `VITE_PACKPROOF_SIGNAL` (web/desktop) default on in this branch and can be set to `false` at build time. Flags are read at startup; they are not switched during a recording. EAS `signal-review` and `signal-ios-simulator` inherit existing internal profiles and retain their release validation.

The review workflow runs **web → Android → iOS and desktop**. Native and desktop packages use existing review controls; no production signing credentials were changed. Desktop development identities are isolated and have no verified publisher signing: Windows is unsigned; macOS uses an ad-hoc signature and is not notarized. iOS output is a simulator app with the Share Extension, not a signed device IPA or TestFlight build.

| Platform | Review configuration |
| --- | --- |
| Web | Production Vite bundle; existing server/auth configuration |
| Android | Existing internal local-review builder; app 1.0.1, versionCode 66, `com.packproof.mobile`; generated review signing key, not Play signing |
| iOS | App 1.0.1, build 1, `com.packproof.mobile`; minimum iOS 15.1; simulator Release build, signing disabled |
| Desktop | Windows x64, macOS x64 and arm64; existing development identities; minimum macOS 13 |

Android compiles/targets API 36; the installed React Native dependency minimum is API 24. Review versionCode 66 is lower than production profile 70 and has different signing: **do not uninstall an existing production app with pending evidence to install this APK**. Use a dedicated review device/profile. These configuration values do not substitute for artifact provenance or installed-device verification.

## Verification scope and current evidence

Only focused state/retention checks and platform compile/package checks were selected, per the request to avoid unnecessary testing. No broad end-to-end or screenshot suite was added.

| Check | Result recorded during implementation |
| --- | --- |
| Native TypeScript | Passed |
| Android and iOS Metro exports | Passed |
| Receipt and recording-review invariants | 5 passed |
| Web retained-take IndexedDB invariants | 3 passed |
| Desktop evidence-engine owner suite | 25 passed, including new review/retake and receipt-retention cases |
| Web and desktop production compilation | Passed |
| First web/Android CI milestone | Passed: [run 39422154754](https://github.com/thepackproof/packproof-v2/actions/runs/39422154754) |
| Final source platform packaging | All six targets passed at `4e5e9163383818a947cfc58519fc89474ffd8caa`; see [build-results.md](build-results.md) |
| Backend read-only health/capability check | Passed; compatibility receipt mode observed |
| Browser integrated screenshot comparison | Not executed: cloud browser could not reach the local preview |
| Physical capture, biometric, lifecycle, permissions, storage, installation and migration | Not executed: no attached device |
| Real-account canonical saved journey and copied-link access | Not executed; no customer records created |

The remaining acceptance work is the plan's installed-app 27-state visual review and the critical physical capture/recovery/account/upgrade/rollback paths, plus a real canonical saved result and shared-link access check. No acceptance row is promoted to pass solely by a build or a unit check. All platform artifacts passed and are ready for internal review; production release gates are not met by this implementation report.
