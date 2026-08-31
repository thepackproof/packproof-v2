# User search and account invitations

PackProof invitations are account-targeted. The primary path is:

```text
Add participant
      ↓
Search PackProof users
      ↓
Select user
      ↓
Invite
      ↓
Pending invitation
      ↓
Recipient accepts
      ↓
Canonical Proof updates
```

Clients do not construct identity from a display name. After a search result is selected, `POST /proofs/:id/invitations` sends the internal PackProof `userId`.

## Search

Authenticated collaboration search, not a public directory.

| Route | Purpose |
| --- | --- |
| `GET /users/search?q=` | Public identity only: `userId`, `username`, `displayName` |
| `GET /proofs/:id/users/search?q=` | Same fields plus server-derived `invitationState` for that Proof |

Proof-scoped search is seller-only and is rejected after `FINALIZED` (`PROOF_ALREADY_FINALIZED`). A buyer or non-participant receives `PARTICIPANT_NOT_AUTHORIZED`.

Query rules:

- leading `@` is stripped (`janesmith` and `@janesmith` match the same account)
- minimum length 2 after normalization
- maximum length 64
- empty or short queries return `INVALID_SEARCH` (no account dump)
- at most 20 results
- `LIKE` wildcards in the query are escaped
- matching is case-insensitive
- order is deterministic: exact username, username prefix, display-name prefix, display-name substring, then `username_normalized`, then `id`

Search never returns email, phone, Cognito subject, auth provider identifiers, or other private profile fields.

## Relationship state

`invitationState` on Proof-scoped results:

| Value | UI |
| --- | --- |
| `NONE` | Invite |
| `SELF` | You |
| `PARTICIPANT` | Already participating |
| `INVITED` | Invitation pending |
| `INELIGIBLE` | Unavailable |

The web and mobile clients render these labels. They do not independently merge search rows with participant or invitation arrays.

## Invitation commands

`POST /proofs/:id/invitations` accepts `{ "inviteeUserId": "user_..." }` or `{ "userId": "user_..." }`. Identifier invitations remain for deep-link compatibility.

Seller-only. Rejected after `FINALIZED`.

| Case | Behavior |
| --- | --- |
| Invite self | `CANNOT_INVITE_SELF` |
| Already a participant | `ALREADY_PARTICIPANT` |
| Pending invitation for that user | return the existing invitation (idempotent) |
| Unknown `userId` | `USER_NOT_FOUND` |

The create response may still include an internal token for compatibility. First-party clients discard it and do not show it.

## Recipient discovery

Pending invitations addressed to the signed-in account are listed by `GET /invitations`. That inbox is the discovery surface used by home on web and mobile. `GET /me/proofs` lists Proofs the user already participates in; it does not become a second inbox.

Inbox items include inviter username/display name and the transaction fields the invitee is allowed to see before acceptance. They do not include tokens.

`POST /invitations/:token/accept` accepts either the invitation id (`inv_…`) or the compatibility token. A targeted invitation cannot be accepted by a different account (`INVITATION_NOT_ADDRESSED`). Repeat accept by the correct user is idempotent.

## Token / deep-link fallback

Token invitations created with `inviteeIdentifier` still work. First-party UI keeps invitation-ID acceptance as a secondary control. The normal path does not ask users to copy or paste a token.
