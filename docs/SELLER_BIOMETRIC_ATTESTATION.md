# Seller shipping attestation

Android seller submission now asks the seller to authenticate this exact statement:

> The item shown and attached in this Proof is the item I am shipping

The recording review shows a generic fingerprint icon above the statement. Pressing it opens Android's system prompt; pressing alone does not submit. The same deliberate confirmation is required in Packing Station, after the single packing recording is finished and reviewed. Cancellation, unavailable biometrics, lockout, and interrupted uploads keep the local recording available. Android does not silently fall back to a PIN, password, or unsigned submission. Existing iOS, web, grading, receipt, and return workflows retain their current behavior.

The regular capture flow commits the video and its attestation, then returns to the Proof. Existing finalization remains a separate server command. Packing Station preserves its existing automatic finalization after successful evidence and attestation commits, subject to the server's participation and capture requirements.

## What becomes part of the Proof

The seller's account, exact recording reference, statement, server recording time, and signed authorization are committed together as an append-only attestation. The statement and original SHA-256 are bound in the signature. The attestation digest covers its authorization, and finalization includes that authorization in the canonical manifest. Android displays the statement beneath its corresponding original, with the server recording time and `Signature verified`. Historical attestations are not relabeled, rewritten, or upgraded.

The signed payload contains version, method, random nonce, challenge ID, authenticated seller ID, Proof ID, native capture session ID, video SHA-256, exact statement, public-key hash, and expiration. The server supplies the payload; the client checks it matches the reviewed recording/account/key and signs its exact UTF-8 bytes.

## Authentication and data boundary

Android Keystore holds an account-scoped, non-exportable P-256 private key requiring fresh strong biometric authentication for each signature. Android's system `BiometricPrompt` authorizes the cryptographic operation. Biometric enrollment changes invalidate the key; the next preparation creates a new key and challenge. Cancellation, app stopping/destruction, prompt timeout, and late native callbacks cannot produce a successful submission.

PackProof does not request, receive, log, upload, or store fingerprint images, biometric templates, raw samples, biometric identifiers, or feature vectors. The displayed fingerprint is a generic icon. Stored public keys and ECDSA signatures are cryptographic verification material, not biometric samples. The API only accepts explicitly documented fields, validates the cryptographic formats, and rejects unknown fields. Native vendor messages and exception causes are not forwarded or logged.

Android's modern API selects an authenticator strength, not a fingerprint modality. `BIOMETRIC_STRONG` may use strong fingerprint, face, or iris authentication supported by the device. No weak biometric or device-credential fallback is enabled.

The server verifies a signature against the submitted public key. It does **not** remotely establish that the key was generated in Android Keystore, that a particular fingerprint was used, or the legal identity of the person authenticating. Stored metadata states `signatureVerification: SERVER_VERIFIED` and `biometricMethodProvenance: CLIENT_ASSERTED_NOT_INDEPENDENTLY_VERIFIED`. No hardware key-attestation certificate chain is validated. The attestation records the seller's assertion; it does not establish the truth of physical package contents.

## API and retry behavior

- `POST /proofs/:id/attestation-challenges` accepts `{ captureSessionId, sha256, publicKey }`. The key is canonical base64 of P-256 SPKI DER. The seller must own the same completed native packing session and matching video hash. The response is `{ challengeId, payload, expiresAt }`.
- `POST /proofs/:id/attestations` accepts `{ statement: "PACKED_DESCRIBED_ITEM", relatedEvidenceId, authorization: { challengeId, signature } }`. The signature is canonical base64 of SHA256withECDSA DER over the returned payload. The server checks actor, Proof, session, committed original, hash, signature, and expiration.
- Unused challenges expire after 24 hours. The same active capture/key challenge is reused, and outstanding challenges are bounded. A fresh request requires fresh device authentication.
- Challenge consumption, attestation insertion, and audit are transactional under the Proof lock. The database prevents challenge payload alteration and attestation mutation.
- An exact consumed challenge can recover its original attestation after expiration or finalization. Retries do not create another attestation, use an unrelated original, or upgrade a legacy statement. Clients recover existing signed authorization only from server state for the same evidence and seller.
- Authentication precedes evidence initialization/upload. If the video commits but the attestation response is lost, the original upload identity remains recoverable. The local original is deleted only after the attestation succeeds. No biometric success flag is persisted as authorization.

## Validation and rollout

Source starts from the simplified Proof experience in PR #34. Android candidate identity is `0.3.5` / version code `34`.

Local validation passed: the full backend suite (498 passed, seven environment-dependent tests skipped), backend typecheck/build, mobile typecheck, and all 14 mobile Proof/tracking tests. The suite includes eight new backend authorization tests, 13 client challenge/recovery tests, and 31 station tests. Android JavaScript/Hermes export passed (772 modules). Expo prebuild and native autolinking resolve the new module. CI includes a Kotlin compilation gate against the generated Android/Expo project. Local native compilation was initially blocked by uncached dependencies; the authorized EAS release build subsequently passed, including the new module's Kotlin compilation. No physical biometric behavior has been tested.

EAS build `ee4d672a-9208-4743-8d54-e68a0c8190be` completed on 2026-09-06 at 23:55 UTC using the `shipping-integration` profile and mobile source from commit `332fea9040e2622c26f2180125431eefb1d92da6`. The signed AAB is `PackProof-0.3.5-build-34.aab` (45,481,386 bytes), SHA-256 `671d0cdad8e47f0e2500ab68ce00c25c717e4d73f0b5dddbec784243a604760b`. Verification confirmed `com.packproof.mobile`, version `0.3.5`, code `34`, the required Play upload certificate, the CMS signature and all 1,641 signed file digests, provider namespaces, biometric permission, native attestation and unified-camera modules, and the exact declaration in the JavaScript bundle. No Expo build credential was present in bundled files.

Deploy the backend and additive migration `034_seller_attestation_authorization.sql` (including the preceding sharing migration from PR #34) before releasing this Android client. The currently deployed API lacks the new attestation challenge endpoint, so the new seller submission flow requires that backend deployment. This feature requires a new native Android binary; it cannot be added to an existing binary by a JavaScript-only update. The AAB build did not deploy the backend or publish a Play release.

Before wider release, validate on Galaxy S24 Ultra and Galaxy A16: successful fingerprint submission; wrong finger/cancel; no enrollment; temporary/permanent lockout; app background/Android Back while prompting; enrollment change; repeated taps; offline before and during upload; app restart after video commitment; both station completion paths; and readability with large text on the smaller display.

References: [Android biometric prompt](https://developer.android.com/identity/sign-in/biometric-auth), [Android Keystore](https://developer.android.com/privacy-and-security/keystore), [Android biometric security](https://source.android.com/docs/security/features/biometric).

GitHub publication status: the initial push was blocked pending explicit authorization. On September 7 the user authorized publication; draft PR [#35](https://github.com/thepackproof/packproof-v2/pull/35) now includes this source alongside the scrolling correction. Its code commit is `e25c866f100b22187a9edc09c9a5450184f25279`. Build 35 preserves the attestation feature; see `ANDROID_SCROLL_FIX.md` for its verified release details. The backend deployment requirement above remains a release gate.
