# iOS shared order intake

`with-order-share` composes `with-ios-order-share`. The existing native extension and host Expo module are reused. The repeatable config plugin supplies the extension target, source membership, embedding, entitlements and EAS credential declarations.

| Production identity | Value |
| --- | --- |
| Host | `com.packproof.mobile` |
| Share target / bundle | `PackProofOrderShare` / `com.packproof.mobile.OrderShare` |
| App Group | `group.com.packproof.mobile.orders` |
| Dedicated shared Keychain access group | `$(AppIdentifierPrefix)com.packproof.mobile.order-share` |

A different host bundle produces different App Group and Keychain identities. The compiled API URL comes from `extra.packproofApiBaseUrl`; the host and extension receive the same pinned URL. Both profiles must contain the App Group and Keychain access group. The real Apple application prefix/team must be provisioned; this plugin does not invent or register an Apple identity. Existing entitlements are preserved.

## Supported flow

1. Share plain text or one HTTP(S) web URL, including a text-only URL, from a source app that supplies it. The native extension prefers a URL representation, rejects other attachment types, bounds provider loading, and shows the destination account and a short preview. There is no OCR or source-site fetching.
2. Tap **Add to PackProof**. A versioned envelope with stable `clientSubmissionId`, account binding, creation time and SHA-256 of its text is atomically persisted before network submission. Secrets never enter the outbox.
3. A valid restricted `pp_intake_` session permits one foreground `POST /me/intake/submissions`, with a three-second budget. Redirects, cookies and credential caching are disabled. The response must match the client submission ID. A 200/201/202 is durable acceptance, not necessarily a resolved order.
4. A server acknowledgment produces **Added to your packing queue** only for `READY`; other accepted states direct the person to finish preparing the order. Without server acknowledgment, the message is **Saved on this iPhone. Open PackProof within 7 days to finish adding it.** Local persistence failure is an error, never success. Tap **Done** to return to the source app.
5. Normal host launch/foreground drains the same outbox through the shared mobile coordinator. No parent-app launch tricks, recording, OAuth flow or background transfer occurs in the extension.

## Persistence and account boundaries

The existing POSIX lock coordinates both processes; atomic protected writes publish complete manifests. The App Group is excluded from backups and uses protection until first unlock. A request being scheduled or a preview being opened never removes pending input. After seven days, unresolved raw text and any legacy files expire on the next store access; the original ID, account binding and hash remain as an `INPUT_EXPIRED` tombstone with an explicit re-share/discard message. Server acknowledgment atomically replaces raw text with a lightweight receipt. Explicit `discard` is separate from acknowledgment. A process termination between server acceptance and local acknowledgment replays the same client submission ID.

The extension snapshots its displayed destination; an account change cannot silently rebind it. New signed-out shares remain unassigned. `assignAccount` requires explicit host UI confirmation, the active account, and an unassigned or matching existing binding. Switching accounts/clearing active identity clears the shared session. The host also revokes the session on the server at logout. Old account submissions remain attached to their original account.

`OrderShareSessionStore` stores only the restricted intake session in a dedicated shared Keychain entry with `AfterFirstUnlockThisDeviceOnly` and synchronization disabled. The host supplies `{ token, sessionId, accountId, accountLabel, expiresAt, apiBaseURL }`; native validation requires an active matching actor, the pinned HTTPS API and a session lasting at most twelve hours. The extension never receives Cognito refresh tokens or marketplace credentials. It saves locally if credentials are missing, expired or inaccessible.

Limits: 20,000 UTF-16 characters; 64 KiB encoded request and response; at most four text representations and one distinct web URL; fifty unacknowledged local submissions. Input is rejected, never silently truncated for submission. The visible preview is separately shortened. Legacy v1 text imports migrate without account assignment. Legacy attachment imports remain quarantined for explicit re-share/discard; unsupported file data is not silently removed.

## Native module contract

- `listPending()` / `readOrder(id)` expose account-bound records and delivery receipts.
- `enqueue(text, payloadKind, surface)` durably saves explicit paste input.
- `setActiveAccount(accountId|null)` updates receiving identity; `assignAccount(id, accountId)` is only called after explicit assignment.
- `acknowledge(id, serverSubmissionId)` retains an acceptance receipt and removes raw payload; `discard(id)` explicitly removes a local record.
- `setIntakeSession(session)` / `clearIntakeSession()` manage the restricted shared credential.

The common TypeScript bridge is `index.ts`. Canonical transaction creation, authorization, resolution, queue state and camera/upload handling stay in their existing backend and application layers.

## Validation and release boundary

Node plugin tests exercise extension credentials, constrained activation, privacy manifests and generated Xcode source membership/embedding/idempotence. Generate the native project with `npx expo prebuild --clean --platform ios --no-install`, then run `node --test tests/order-share-plugin.test.cjs`. The generated extension must include both `OrderShareSessionStore.swift` and `ShareIntakeTransport.swift` and remain extension-safe.

A Linux prebuild is not a Swift compile, signed archive, TestFlight delivery or physical-iPhone check. Before iOS release, compile this final candidate with the supported Xcode/EAS image and verify these distinct device boundaries:

- URL/text sharing, delayed providers and unsupported/oversized content; no local success on storage failure.
- Signed-out save, explicit account assignment, account switching and logout/session revocation.
- Offline save/reopen, expired restricted session, and interruption after server acceptance; one canonical submission on replay.
- Extension returns to source; later queue/capture uses normal host navigation and preserves any active recording/upload recovery.

The real Apple team/signing identity, archive compile, physical-device capture/attestation/recovery and TestFlight delivery remain release gates wherever no verified result is recorded in the deployment handoff.

References: [Apple shared containers and POSIX coordination](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionScenarios.html), [Apple shared Keychain access](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps), [Expo EAS app extensions](https://docs.expo.dev/build-reference/app-extensions/).
