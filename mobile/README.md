# PackProof V2 mobile client

Thin Expo client over the V2 API. It does not own Proof lifecycle state.

## Run

1. Start the API. For local development use `PACKPROOF_AUTH_MODE=dev` and `PACKPROOF_DEV_AUTH=true`.
2. `npm install`
3. `npm start`
4. Open on an Android device or emulator.

Development mode still accepts subjects such as `seller-1` and `buyer-1`. Production-capable accounts use `PACKPROOF_AUTH_MODE=cognito` on the API and `cognito` in the client. The client talks to Cognito directly for sign-up, verification, sign-in, and password reset. It never sends a password to the PackProof API.

On a physical device in Expo Go, set the API base URL to the machine LAN address, for example `http://192.168.1.10:3000`. That override is development-only. Google Play / release builds always use the compiled staging API and Cognito settings from `eas.json` profile `internal-staging` and ignore a cached localhost URL.
