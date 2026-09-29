# App Store screenshot capture

This isolated simulator entry point renders the existing production screens with synthetic shipment records. It does not change layouts, add features, access production accounts, or issue real shipment API requests. The normal App.tsx entry point is untouched in the signed release job.

Run only in a disposable checkout: `PACKPROOF_STORE_SCREENSHOTS=1 node store-assets/prepare.cjs`, compile the iOS simulator Release app, then run `bash store-assets/capture.sh /path/to/PackProof.app`.

The capture script saves five opaque JPEG screenshots directly from an Apple 6.9-inch iPhone simulator. Inspect every screenshot before upload. The tracking records, names, order references and amounts are illustrative sample data. No production customer data is used. No camera or biometric capture is asserted by these screenshots; physical-device capture acceptance remains separate.
