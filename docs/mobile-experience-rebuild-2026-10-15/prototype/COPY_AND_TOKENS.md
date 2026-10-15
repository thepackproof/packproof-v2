# G1 exact copy and design tokens

## Completion copy dictionary

| Fact / context | Exact proposed product copy | Primary action / rule |
|---|---|---|
| New account | Create your first Proof | Create Proof |
| Manual entry | What are you packing? | Continue to camera |
| Pre-record instruction | Keep the item and package in view as you pack and seal. Show the label if available. | Start recording; label optional in ordinary audited recipe. |
| Recording active | Recording | Finish recording |
| Local durable take | Recording saved on this device. Not uploaded yet. | Review and explicit declaration; no success styling. |
| Declaration | The item shown and attached in this Proof is the item I am shipping | Confirm and submit; version 1, unchecked initially. |
| Required native authorization | Confirm on your device | Simulate secure authorization in prototype only. |
| Offline queue | Waiting for connection. Your recording is saved on this device. | View pending upload; no demand to re-record. |
| Transferring | Uploading your recording | Progress uses simulated transferred MB and percentage. |
| Server received | Recording received. Finishing your Proof. | Do not show finalized yet. |
| Server finalized | Your Proof is finalized. | View Proof; Share secondary and role-gated. |
| Unknown acknowledgement | Checking the latest status. | Check status on same job; no blind duplicate submit. |
| Failed submit | We could not finish this Proof. | Specific recoverable failure context. Upload screen uses “Let’s finish your upload” plus transfer failure detail. |
| Interrupted take | Recording interrupted | Partial take is not a valid continuous packing recording. |
| No tracking | No tracking added / Tracking is optional. | Add tracking opens focused form. |
| Integrations | Optional — you can create a Proof without a connection. | Manual route retained. |
| Buyer waiting | Waiting for the seller to add packing evidence. No action is needed from you. | View authorized shared evidence. |
| New capture offline | A new Proof and capture session need an online eligibility check. | Preserve item entry; restore connection before capture. |

The declaration text is from `backend/src/domain/attestation-authorization.ts` (`SELLER_SHIPPING_STATEMENT`). Version 1 is checked in `mobile/src/capture/capabilities.ts`. All other copy is proposed presentation text; current live policy takes precedence. External controls explicitly say “Interactive design prototype • simulated data/camera/upload; not an Android build.” The video illustration and unavailable providers also carry explicit fixture limitations.

## Screen read-state copy

These exact messages are presentation fixtures. The complete source dictionary is exported in `screen-state-matrix.json` and `Prototype.screenStateCopy`.

| Surface | Loading headline | Error headline | Recovery / state distinction |
|---|---|---|---|
| Home / Proofs | Loading your Proofs… | We couldn’t load your Proofs | Saved recordings protected; retry or pending-upload access. |
| Capture | Loading capture options… | Capture options are unavailable | No recording started; retry current capability lookup. |
| Camera | Preparing the camera… | The camera couldn’t start | Item details retained; Try camera again. |
| Review | Opening your recording… | We couldn’t open this recording | Original retained; Try opening again; no demand to retake. |
| Evidence | Loading evidence… | Evidence is temporarily unavailable | Check latest record without inventing finalization. |
| Shipment | Loading shipment details… | Shipment details are unavailable | Tracking lookup cannot change evidence status. |
| History | Loading history… | History is temporarily unavailable | Failed load does not mean the Proof has no activity. |
| Updates | Loading updates… | Updates are unavailable | Cached Proofs remain accessible. |
| Integrations | Loading selling accounts… | Selling accounts are unavailable | Manual creation is independent of a connection. |
| Profile / Settings | N/A: local menu | N/A: local menu | Remote account reads belong to the corresponding destination. |

All offline data surfaces explicitly identify cached/saved details and possible missing recent server updates. Offline Review says “Your recording is saved here. Review it now; reconnect to securely confirm and submit.” Offline tracking save says “Reconnect to save tracking to this Proof. Your entered details are kept here.” Unknown upload acknowledgement offline cannot advance to server received; it offers reconnection.

| Simulated provider state | Exact feedback |
|---|---|
| Awaiting authorization | Waiting for Shopify authorization |
| Canceled | Connection canceled. No selling account was connected. You can try again or create a Proof manually. |
| Failed | We couldn’t connect Shopify. Try again when you’re ready. Your existing Proofs are unchanged. |
| Expired | Shopify authorization expired. Reconnect to refresh orders. Previously imported records are kept. |

## Semantic colors

| Token | Light | Dark | Use |
|---|---|---|---|
| Background | `#F5F8FC` | `#111C2B` | App canvas |
| Surface | `#FFFFFF` | `#192738` | Toolbar, sheet, fields |
| Secondary surface | `#EDF2F8` | `#223247` | Quiet metadata |
| Text | `#192A3E` | `#EDF4FC` | Main labels |
| Secondary text | `#53657B` | `#ACBDCF` | Supporting copy |
| Primary | `#1D68BD` | `#4B9AF0` | Dominant action / selected navigation |
| Primary button text | `#FFFFFF` | `#081D36` | Deliberate dark text on lighter dark-theme blue |
| Primary tint | `#E8F1FC` | `#203A57` | Focal task / selection |
| Success | `#177965` | `#43C8AC` | Actually achieved fixture milestones |
| Pending | `#89500C` | `#F1B754` | Queued / unknown / recoverable warning |
| Failure | `#B23650` | `#F5909B` | Failed or interrupted state |
| Divider | `#DCE4EE` | `#314358` | Compact rows / surfaces |

Color accompanies text/icon meaning. A local-save milestone can be marked saved in the progress list, but the Proof stays pending until the separate server-finalized event. Review/local-save surfaces do not carry a finalized badge.

## Typography and rhythm

- System sans-serif; heading 27 px / 800, section heading 20 px / 750, row title 14 px / 750, body 14–15 px, secondary 12–13 px at the baseline. Compact hero title 19 px / 750. Weight and spacing establish the hierarchy; no web font request.
- Page side padding 16 px. Rhythm 8 / 12 / 16 / 24 px. App bar minimum 56 px; default controls minimum 48 px and expand with text. Supporting rows have dividing rules instead of nested cards.
- Normal catalog rows target 72–92 px; settings 59 px; profile rows 53 px. Height grows for large text. Profile max-height 86% (94% at 200% type), with internal scrolling.
- Four labeled destinations: Home / Proofs / Capture / Updates. Evidence / History / Shipment are local Proof tabs, not new bottom destinations.
- 200 ms progress-width transition only; `prefers-reduced-motion` disables transitions and smooth scrolling. Automatic demo events are optional reviewer controls, not proposed production animation.

## Measurement limits

All numbers above are CSS design values. The static renderer and DOM tests do not prove native dp/sp size, contrast under actual display conditions, clipping, device keyboard behavior, TalkBack or focus behavior in React Native. The later Android implementation must reuse these approved compositions through verified native components and test them on real devices.
