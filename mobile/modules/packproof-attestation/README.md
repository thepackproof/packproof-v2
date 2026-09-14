# PackProof native biometric attestation

Local Expo SDK 52 module, auto-linked from `mobile/modules` during iOS or Android prebuild.
It requires a new native build; Expo Go and older PackProof binaries receive
`ATTESTATION_UPGRADE_REQUIRED` from the TypeScript bridge.

## iOS security boundary

- `PackProofAttestationModule.swift` uses Security.framework, LocalAuthentication,
  and an account-scoped P-256 private key generated inside the Secure Enclave.
  The application tag is a SHA-256 digest of the account ID. It never exports the
  private key, reads biometric samples, or reads/stores biometric enrollment IDs.
- Access control combines `privateKeyUsage` with `biometryCurrentSet` and
  `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`. No `userPresence`,
  `devicePasscode`, OR constraint, or password fallback is used. Changing the
  enrolled biometric set invalidates the key; disabling the device passcode also
  makes it unusable. The key does not migrate through device backup or iCloud.
- Every signing request uses a newly created `LAContext`, zero authentication
  reuse duration, and an empty fallback-button title. `SecKeyCreateSignature`
  evaluates the key's biometric access control for that signing operation;
  a standalone authentication success boolean never authorizes submission.
- The SHA-256 ECDSA signature covers the exact UTF-8 server challenge. Public keys
  use SPKI DER base64; signatures use ASN.1 DER base64, matching Android and the
  verifier. The bridge checks the challenge's account, `IOS_BIOMETRIC` method, and
  public-key hash before signing; shared TypeScript checks its remaining bindings.
- `prepareKey` reads or creates a key without prompting. Only preparation may
  replace an invalidated key. A key invalidated after challenge creation fails
  signing; it never silently signs that challenge with a replacement. Retry
  prepares a new key and obtains a fresh challenge. Cancellation, lockout, and
  ordinary authentication failure do not rotate a key.
- Native operations run on a dedicated serial queue. Backgrounding, explicit
  cancellation, destruction, and timeouts invalidate the operation's context and
  reject the pending promise. Late results are discarded, and the operation lock
  remains held until its worker exits. The biometric system prompt itself may
  make the app inactive, so only actual background entry cancels it.
- A physical device with available Secure Enclave and enrolled Face ID or Touch ID
  is required. The simulator reports unavailable and has no software-key bypass.
  `NSFaceIDUsageDescription` must be present in the app's generated Info.plist.
- The backend verifies the digital signature and all existing evidence bindings.
  The receipt records `IOS_BIOMETRIC` together with
  `CLIENT_ASSERTED_NOT_INDEPENDENTLY_VERIFIED`. It does **not** claim that a server
  has independently verified the device hardware, biometric modality, or honesty
  of the signed statement. No App Attest assertion is fabricated.

## iOS release validation

The TypeScript and backend tests exercise challenge-method binding, Apple public
key wire compatibility, DER signature verification, platform-specific retries,
key replacement, expiry, and evidence binding. They do not execute Apple's
Secure Enclave or establish physical-device readiness.

Before TestFlight/public distribution, compile/archive with the selected Apple
signing team and verify on both a Face ID device and a Touch ID device:

1. First preparation and relaunch use the same account-scoped public key; another
   account gets a different key. Preparation does not display an auth prompt.
2. Each consecutive submission requests fresh Face ID/Touch ID, even immediately
   after device unlock. No passcode fallback can complete the attestation.
3. Denied Face ID permission, no enrollment, lockout, cancellation, backgrounding,
   and timeout retain the recording without creating an attestation.
4. Successful signatures verify against their exact server challenges, evidence,
   and account, and finalized evidence preserves the iOS method and provenance.
5. Change enrollment between preparation and signing: the old challenge cannot
   be signed, and a fresh prepare/challenge/sign succeeds with a replacement.
6. Repeat after app termination, passcode removal/re-enrollment, and restoration
   onto another device. Lost-response retries recover the original server record.

Apple references: [Secure Enclave key protection](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave),
[current biometric set access control](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/biometrycurrentset),
[authentication context](https://developer.apple.com/documentation/security/ksecuseauthenticationcontext),
[authentication reuse duration](https://developer.apple.com/documentation/localauthentication/lacontext/touchidauthenticationallowablereuseduration),
[LAContext and Face ID permission](https://developer.apple.com/documentation/localauthentication/lacontext).

## Android security boundary

- Android owns biometric enrollment, templates, matching, and its system prompt.
  PackProof receives authentication callbacks only. This module never requests,
  reads, stores, transmits, or logs biometric images, raw biometric measurements,
  templates, enrollment identifiers, or vendor biometric error strings.
- `prepareKey(userId)` creates an account-scoped P-256 signing key in Android
  Keystore. Its alias uses a SHA-256 digest of the account ID. The private key is
  non-exportable; only the public key is returned as SPKI DER in base64. This does
  not claim that every supported device uses hardware-backed key storage.
- The key requires a fresh strong biometric authentication for each use. No
  timed authorization window, PIN/password fallback, or weak biometric fallback
  is allowed. AndroidX `BiometricPrompt` receives a `CryptoObject(Signature)`;
  an ordinary success boolean cannot unlock submission by itself.
- `sign(userId, payload)` signs the exact UTF-8 payload, without parsing,
  reserializing, or normalizing it, using `SHA256withECDSA`. The response is an
  ASN.1 DER ECDSA signature encoded as base64. The backend must verify it against
  its own account-, Proof-, evidence-, and nonce-bound challenge before accepting
  the attestation. A signature alone is not a claim that item contents are true.
- The supported authenticator class is `BIOMETRIC_STRONG`. Android chooses the
  eligible modality, potentially fingerprint, strong face, or iris. The public
  API does not enforce fingerprint-only authentication, and the returned record
  must not assert a specific modality.
- Adding biometrics invalidates the key. The next `prepareKey` detects this and
  replaces it before the caller requests a challenge. `sign` rejects an already
  issued challenge if the key becomes invalid; it never silently replaces the
  key and signs under another identity.
- The module permits one pending signing request at a time. A request ends after
  five failed matches, system errors, cancellation, activity stop/destruction,
  module destruction, or a 90-second timeout. Late callbacks cannot sign or
  resolve an already cancelled request. There are no native logs or analytics.
- Key preparation runs on a dedicated worker so Android Keystore generation and
  enrollment checks do not block UI animations. A main-queue operation lock
  prevents signing while the worker is active. Cancelling preparation rejects
  its promise immediately but retains the lock until that worker returns; late
  results after cancellation or module destruction are discarded.

## Bridge methods

| Method | Result |
| --- | --- |
| `getAvailability()` | `{ available, code?, message? }` for strong biometric enrollment/support |
| `prepareKey(userId)` | `{ publicKey }` |
| `sign(userId, payload)` | `{ signature }` after a new system prompt |
| `cancel()` | Cancels the pending prompt, if any |

`BIOMETRIC_CANCELLED` means the caller must retain the recording and avoid
submission. `BIOMETRIC_NOT_ENROLLED`, `BIOMETRIC_LOCKED_OUT`,
`BIOMETRIC_UNSUPPORTED`, `BIOMETRIC_SECURITY_UPDATE_REQUIRED`, and
`ATTESTATION_KEY_INVALIDATED` have actionable messages. No failure falls back to
an unsigned attestation.

## Native release validation

On the Galaxy S24 Ultra and Galaxy A16 test devices, verify:

1. Fresh install and existing account both create a key; relaunch returns the
   same public key. Different accounts receive different keys.
2. Each consecutive submission opens the Android biometric prompt, including
   immediately after unlocking the phone. No PIN or account-password option is
   available in that prompt.
3. Cancel/back, backgrounding, five mismatches, and lockout retain the local
   recording and create no attestation. Foreground retry opens a fresh prompt.
4. A successful signature verifies server-side over the exact challenge bytes;
   modified payloads and a public key from another account fail verification.
5. Enroll an additional fingerprint. A challenge issued against the old key
   cannot be signed; a fresh prepare/challenge flow works with the replacement.
6. Devices without a supported enrollment show the setup/availability message
   before any upload. Older binaries show the update requirement.
7. Inspect network payloads and the final Proof: only ordinary attestation
   fields, the public key, and the digital signature are present; no biometric
   samples or modality assertions are collected.

Platform references: [Android biometric authentication](https://developer.android.com/identity/sign-in/biometric-auth),
[Android Keystore](https://developer.android.com/privacy-and-security/keystore),
[key authorization parameters](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec.Builder).
