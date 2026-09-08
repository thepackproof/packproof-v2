# Android scrolling correction — September 7, 2026

## Failure and cause

The supplied Android recording shows the My Proofs list repeatedly reversing position while scrolling. The list sent every native scroll event through `setProofsLibrary`, rerendering the application context and list. `AppScreen` then passed the latest JavaScript offset back through the native `contentOffset` prop. Android's installed React Native implementation turns changes to that prop into `scrollTo` calls. Delayed JavaScript positions therefore competed with the active native gesture and momentum.

The Proof record and Proof tools screens also bound `contentOffset` to live saved values, allowing unrelated renders to cause the same correction.

## Correction

- Store the My Proofs offset in a provider ref, separate from reactive search/filter state. Scrolling no longer publishes application context updates.
- Remove all live `contentOffset` bindings from the mobile client.
- Use one shared scroll wrapper to restore a saved position once per mounted screen or tab, after viewport/content measurements and required content are ready.
- Clamp restoration to the available content, ignore stale pre-restoration events, and let the user's gesture or deliberate scroll command cancel a pending restoration.
- Keep existing screen/tab return positions, native scrolling, and interaction animations.

The change is confined to client presentation state. It does not change Proof meaning, capture, biometric attestation, shipping integration, or backend state.

## Validation and release status

Validation passed: all 21 focused mobile Proof/tracking/scroll tests (including seven new scroll cases), mobile TypeScript check, and Android Metro/Hermes export (774 modules). The scroll cases cover delayed content, stale offsets, clamping, cancellation, native pixel rounding, and returning to a tab. Independent code review also checked deliberate scroll actions during delayed loading. These tests do not simulate Android rendering or establish performance on a physical phone. The additional backend-hosted mobile presentation tests could not start locally because Vitest was unavailable; the subsequent GitHub CI run passed Backend, Web, Mobile, PostgreSQL migration concurrency, Android attestation Kotlin, deployment-script, and CodeQL checks.

The baseline is the build-34 source at `5aa6b91`, including the simplified Proof experience and seller biometric attestation. The existing attestation backend deployment requirement in `SELLER_BIOMETRIC_ATTESTATION.md` still applies.

The user explicitly authorized GitHub publication and existing Expo/EAS account and signing-key use on September 7, following the initial automatic approval block. Draft PR [#35](https://github.com/thepackproof/packproof-v2/pull/35) publishes the source. Its code commit `e25c866f100b22187a9edc09c9a5450184f25279` has the exact same tree (`7cf055d9d9018e46b0a6ebb6310f58cdb68aa419`) as local release commit `425eb51308174d3061cedd38727b0926e05c68b9`.

EAS build [2939924c-2cba-41d0-9326-77568faab52e](https://expo.dev/accounts/packproof-llc/projects/packproof/builds/2939924c-2cba-41d0-9326-77568faab52e) finished successfully using `shipping-integration`. The verified bundle is `PackProof-0.3.6-build-35.aab`, 45,482,496 bytes, SHA-256 `b4165bc555ff75b8336f308b391d9f07643372d8096094b5089064bd99e804b9`. Verification confirmed package `com.packproof.mobile`, version 0.3.6, code 35, the required Play upload certificate, the CMS signature and all 1,641 signed file digests, provider namespaces, biometric permission, native attestation/camera modules, exact seller declaration, and compiled scroll-restoration code. No Play release or backend deployment was performed.

Before distributing the next build, exercise repeated upward/downward flings on both test phones, open a Proof and return, switch In Progress/Completed, return from an Activity event, and interact while bookmark/network loading is delayed. Confirm position stays under the user's control and saved positions still return correctly.
