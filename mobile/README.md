# PackProof V2 mobile client

Thin Expo client over the V2 API. It does not own Proof lifecycle state.

## Run

1. Start the API with `PACKPROOF_DEV_AUTH=true` and `PACKPROOF_PUBLIC_URL` set to a URL the device can reach.
2. `npm install`
3. `npm start`
4. Open on an Android device or emulator.

Use `seller-1` and `buyer-1` as the two development subjects. On a physical device, set the API base URL to the machine LAN address, for example `http://192.168.1.10:3000`.
