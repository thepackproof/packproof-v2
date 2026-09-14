# iOS shared order intake

`with-order-share` preserves Android text sharing and composes `with-ios-order-share`. The latter creates the native Share Extension, declares it to EAS before credential preparation, and gives both targets an App Group. The app-side Expo module auto-links from `mobile/modules`.

For the production bundle identifier `com.packproof.mobile`:

- App: `com.packproof.mobile`
- Extension target: `PackProofOrderShare`
- Extension bundle identifier: `com.packproof.mobile.OrderShare`
- App Group: `group.com.packproof.mobile.orders`

Both device provisioning profiles must include that App Group. EAS config plugin metadata declares the extension under `extra.eas.build.experimental.ios.appExtensions`. An Apple Developer team is needed for device/TestFlight signing. A fresh prebuild is required after changing the app identifier. The extension uses the application's version/build values.

The extension includes its own `PrivacyInfo.xcprivacy` in its resource build phase, and the app-side pod packages a separate `PackProofOrderShare_privacy.bundle`. Both declare file metadata reason `C617.1` for App Group inbox validation and expiration. The extension additionally declares `3B52.1` for metadata of the files the person explicitly shares. These reasons match [Apple’s required-reason API definitions](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype). Neither component tracks users or sends file timestamps off-device.

## Flow and safeguards

1. In another app, share text, an HTTP(S) link, JPEG, PNG, HEIC, WebP, or PDF to PackProof, then tap **Save order**.
2. The extension streams temporary files into its own protected App Group folder, checks sizes and actual decodability, and atomically publishes a manifest only after all files arrive. Cancellation removes the partial folder. Each import has its own random UUID; names and paths supplied by a host are never used as destinations.
3. Open PackProof. Once signed in and on the home screen, it reads the oldest pending import. Reading does not delete anything. Apple Vision reads images locally; PDF text is extracted with PDFKit, with bounded OCR rendering for scanned pages. Links are treated as text; this module never fetches a shared URL.
4. Review/edit the resulting text before the existing authenticated order-preview API receives it. Original attachments do not become packing evidence. Back defers the import until the next foreground visit. Use or explicit discard acknowledges the manifest and removes the copied source files. Termination before acknowledgment leaves the native queue available for a retry.

Limits: four items per share, 10 MiB per attachment, 20 MiB total attachments, 20,000 UTF-16 characters, 12 PDF pages, 50 megapixels per source image, and ten queued imports. Unsupported, encrypted, oversized, or incomplete files are rejected. On-device OCR is a best-effort draft, clearly labeled for review; absence of readable text remains editable. Source files are excluded from backups and protected until the device has been unlocked after boot. Pending imports expire after seven days, and abandoned unpublished copies after one hour; cleanup runs on the next inbox operation.

The Share Extension intentionally uses Apple's supported completion flow and tells the person to open PackProof. It does not use responder-chain/private-API tricks to launch its containing app.

## Verification

On any build host with Node dependencies installed:

```sh
cd mobile
npx expo prebuild --clean --platform ios --no-install
npx expo-modules-autolinking resolve --platform apple
node --test tests/order-share-plugin.test.cjs
npx tsc --noEmit
```

The generated-project integration test verifies actual Xcode source build phases, embedding, target dependency, matching entitlements, and plugin idempotence. A Linux prebuild is not a Swift compilation or device test. Compile with Xcode/EAS before release and run these iPhone checks:

- Share an order email as text, a Safari URL, a screenshot, a digital PDF, and a scanned PDF; review the extracted draft and create the expected order.
- Share while signed out and while a recording is active. Sign in/finish the recording and return home; import must wait until then.
- Save an import, force-close PackProof before review, and reopen. Back out of review, foreground the app again, then use or discard. Originals should remain until use/discard.
- Cancel during copying; try a 10 MiB-plus file, an encrypted PDF, a 13-page PDF, and an unsupported file. No incomplete order should appear.
- Queue multiple orders and confirm each appears once after acknowledgment. Fill the inbox and confirm the user-facing capacity message.

References: [Apple shared-container and activation guidance](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionScenarios.html), [Apple Share Extensions](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/Share.html), [Expo EAS app extensions](https://docs.expo.dev/build-reference/app-extensions/).
