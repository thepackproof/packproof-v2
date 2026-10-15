# PackProof Android G1 interactive design prototype

**Design review artifact only.** This is not an Android build, a deployed application update, or proof that any native journey works. It makes no network, camera, microphone, biometric, filesystem, account, billing, marketplace, evidence or production calls. All items, events, media, signatures, uploads and server responses are simulated in memory. Reloading resets the simulation.

Open `index.html` in a browser. It is self-contained and needs no installation, dependencies, external fonts or network. The brand images are embedded copies of the repository’s existing `mobile/assets/packproof-symbol.png` and `packproof-symbol-reversed.png`; the logo has not been redesigned.

## Review the two required journeys

1. Choose **1 · Create a manual Proof** outside the phone. Inside: Create Proof → enter a short item description → Continue to camera → Start recording → Finish recording → explicitly check the declaration → Confirm and submit → Simulate secure authorization. The fixture progresses through uploading, server received and server finalized separately. Open the final Proof. Editing the item or retaking clears the declaration; the local file alone never permits finalization.
2. Choose **2 · Recover an interrupted upload**. Inside: Resume upload → Retry upload. The same simulated source and job are retained. The journey reaches server receipt and then server finalization, with no new recording or duplicate signing prompt. Switch **Simulated server** to **Step manually** to inspect every event; **Advance simulated event** moves 0% → 50% → server received → finalized. An unknown acknowledgement requires an explicit status check before the automatic finalize event can proceed.

The incomplete-camera-take scenario is separate from the interrupted-upload scenario. A partial take cannot be submitted as a complete continuous recording. A retake requires the user to confirm that the full activity can be repeated.

## Review controls

| Control | Meaning |
|---|---|
| Surface buttons | Jump to the 12 required design compositions; Review creates an unsigned saved-media fixture if necessary. These are reviewer controls outside the product. |
| Scenario | Reset to a deterministic named state. This also clears any simulated user edits. |
| Screen state | Standard / empty / loading / error / offline on the selected screen. Empty deliberately resets to a coherent empty data fixture where applicable; other read states preserve source/job metadata. The inspector labels N/A states. Use Standard for the two full journeys. |
| Appearance | Light or dark semantic tokens. |
| Viewport width | 320 / 360 / 393 / 411 **CSS px** design width. Native dp equivalence has not been verified. |
| Text size | 100% / 130% / 200% CSS scaling of product typography. This does not substitute for Android font-scale and TalkBack testing. |
| Simulated server | Automatic events, or deterministic manual stepping. |
| Advance event | Simulated transfer progress or explicit status reconciliation, never a real server request. |
| Inspector | Current role, local source, job, revision, declaration binding and server-finalized state. |

Integrations also model a pending provider response (cancel or advance the simulated event), cancellation, failure with retry, and expired authorization with reconnect. No OAuth URL, credential or provider request is used.

The profile menu is a compact modal sheet. Its six entries work, overlay/Escape dismiss it, keyboard focus is contained, and cancel restores the invoking action. Settings and provider rows are compact. Search, Proof filters, order search, tabs, history expansion, tracking form and optional preferences work within the simulation. Starting another Proof parks the existing record and its source/job in the in-memory list; selecting it restores the same job. Scanning a recognized existing record resumes that record.

## Public test / snapshot API

```js
Prototype.setAutoAdvance(false);
Prototype.setScenario('resume');
Prototype.setTheme('dark');
Prototype.setScale(2);
Prototype.setWidth(320);
Prototype.navigate('shipment');
Prototype.setViewState('error');
const { state, html, phoneHtml } = Prototype.snapshot();
```

`html` is a full script-free HTML document containing the same CSS and rendered phone DOM. `phoneHtml` contains only the phone’s internal DOM. `Prototype.staticDocument(state)` also creates a full static document. A browser DOM is needed to obtain the embedded stylesheet; pure model tests can use `renderPhone(state)` and `renderScreen(state)` without a DOM.

Other exported functions: `getState()`, `dispatch(action, payload)`, `render()`, `createState(scenario, preservedDisplaySettings)`, `transition(state, action, payload)`, `nextAction(state)`, `copy`, `screens`, `scenarios`, `screenStateCopy`, `stateCoverage`. The exported `screen-state-matrix.json` records exact read-state copy and applicability. `setViewState(mode)` selects a synthetic screen-read state. An applicable Empty selection resets the demo dataset and returns to Standard on the first in-phone interaction; loading/error/offline preserve existing source and job identifiers. The transition and presentation functions do not call production code and are not proposed replacements for the application’s domain state machines.

Useful actions: `create`, `field:title`, `prepare`, `start`, `finish`, `attest`, `submit`, `authorize`, `advance`, `retry`, `reconnect`, `network-off`, `interrupt-upload`, `unknown`, `back`, `interrupt-recording`, `tracking-save`. Actual DOM interactions remain preferable for interaction tests.

## Source-aligned assumptions

- Ordinary seller packing uses a continuous video. This design adds no default mandatory photos or recipient invitation.
- A new manual Proof/capture requires an online server eligibility response. A previously saved source can remain available offline. The prototype’s offline-start blocker preserves the item entry.
- The declaration reproduces `SELLER_SHIPPING_STATEMENT` exactly. Its version is `1`, consistent with the capability check in `mobile/src/capture/capabilities.ts`. The native authorization step remains explicit and simulated; no real biometric operation or device-key signature is performed.
- Capture allowance is represented as a server response. The design does not invent a universal paywall, free-proof balance, price or purchase policy.
- Labels are optional in the ordinary fixture. A conflicting identifier requiring policy review is not implemented; that remains a documented design variant.
- The provider list is a fixture, not a claim about the current production availability of Shopify, Etsy or eBay.
- Buyer/waiting is a view-only fixture. It hides seller capture/own-action rows and seller sharing actions.

## What remains outside this artifact

See `STATE_MATRIX.md` for exact design coverage and gaps. Camera playback uses a visibly labeled parcel illustration, not a video file. There is no actual recording, hash, signed declaration, retained source file, durable queue, background service, OS permission, device storage check, deep link, backend reconciliation, marketplace authorization, payment, export or account deletion. Only their presentation and relevant click sequences are modeled.

Detailed receiving/return/witness/grading/export/API screens deliberately stop at contextual explanatory design destinations. Those links remain discoverable, but the artifact does not claim their production workflows are implemented. Runtime feature flags and provider eligibility are unknown. Account switching, account-auth expiry, true interruption/force-stop, conflicting-label review, supplemental-photo recipes and real media playback still require further design fixtures or native validation as applicable. Selling-account authorization pending/canceled/failed/expired states are now simulated separately from account authentication. Read-state coverage for each required surface is documented in the matrix, including explicit N/A cells for local navigation shells.

`verify-prototype.cjs` and `VERIFICATION.md` are maintained by an independent review agent. DOM tests cannot establish visual clipping, native tap targets, physical-device performance, TalkBack behavior or evidence integrity. The static render atlas is design evidence, not Android screenshots.

**Gate:** submit this version and the G0 audit for explicit founder G1 review. No production screen implementation is authorized by a successful prototype check.
