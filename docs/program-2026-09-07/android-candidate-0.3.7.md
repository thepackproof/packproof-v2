# Android implementation candidate 0.3.7 (36)

The next standard `com.packproof.mobile` source candidate is version `0.3.7`,
Android version code `36`. It advances the recorded `0.3.6` / `35` baseline; prior
code-35 build records remain historical evidence. The source identity lives in
`mobile/app.config.js`; `mobile/tests/release-identity.test.cjs` checks the current
candidate and disabled automatic device backup. Native Android/iOS npm scripts
use `expo run:android` / `expo run:ios`, matching Expo prebuild output so the build
does not change tracked source. Expo Go commands remain `android:go` / `ios:go`.

This candidate adds native capture timing only after explicit account/dataset
study consent, using durable timing journals and native cryptographic operation
nonces. The recording recovery journal remains separate. See
`observation-collection.md` for privacy boundaries and coverage limitations.

The local verification is TypeScript, native timing/runtime tests and Android
JavaScript/Hermes export. Final-source Android compilation and debug APK identity
must come from the hosted CI run for this candidate's exact source commit. A debug
APK is not a Play-distributed or production-signed release. Neither local tests nor
CI compilation establish the S24 Ultra/A16 physical-device accessibility, biometric,
offline-recovery or timing acceptance matrix.
