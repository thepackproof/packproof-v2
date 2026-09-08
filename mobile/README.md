# PackProof V2 mobile client

Thin Expo client over the V2 API. It does not own Proof lifecycle state.

Orders is the default destination. Open an order or enter the minimum manual shipment detail, review the camera preview, and deliberately record one uninterrupted packing video. Barcode analysis shares that recording; there is no separate required scan/photo/rescan. Finish opens review and the exact shipment statement; Android strong-biometric confirmation submits through recoverable upload, commit, attestation and finalization. Only server FINALIZED means Proof saved. Batch packing reuses the same flow. Proofs and Account are the other primary destinations.

See [redesign implementation and release gates](../docs/ui-ux-redesign-2026-09-08/README.md). Native camera/biometric testing requires a development or release build, not Expo Go.

## Run

1. Start the API. For local development use `PACKPROOF_AUTH_MODE=dev` and `PACKPROOF_DEV_AUTH=true`.
2. `npm install`
3. `npm start`
4. Open on an Android device or emulator.

Development mode still accepts subjects such as `seller-1` and `buyer-1`. Production-capable accounts use `PACKPROOF_AUTH_MODE=cognito` on the API and `cognito` in the client. The client talks to Cognito directly for sign-up, verification, sign-in, and password reset. It never sends a password to the PackProof API.

On a physical device in Expo Go, set the API base URL to the machine LAN address, for example `http://192.168.1.10:3000`. That override is development-only. Google Play / release builds always use the compiled staging API and Cognito settings from `eas.json` profile `internal-staging` and ignore a cached localhost URL.

Internal Testing identity and upload-certificate checks are in [docs/ANDROID_PLAY_RELEASE.md](../docs/ANDROID_PLAY_RELEASE.md). The Play listing is `com.packproof.mobile`.
