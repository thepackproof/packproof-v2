# W03: media admission and exact-version playback

Implementation scope: backend gateway, resumable transport, capture parser, storage adapters and playback. This document distinguishes implemented controls from release evidence still required.

## Transport and compatibility

New runtime upload contracts use `/upload/admission_<opaque-token>`. Tokens are stored only as SHA-256 hashes; a renewed contract invalidates its predecessor. A contract expires after one hour. The reservation and retained staging recovery window lasts seven days; renewal does not reset cumulative ingress accounting. An initialize retry returns `upload.received: true` when complete bytes already arrived, so clients proceed to commitment after a lost upload response.

Before reading a request body, the gateway resolves the capability, locks its reservation and checks declared media type, fixed Content-Length, expiry, pending evidence, exclusive request lease and remaining ingress allowance. A body cannot exceed 250,000,000 bytes or its capture's previously registered exact size. The whole declared body is charged before any storage write. Failed requests keep the charge. The default cumulative allowance is twice the reserved recording size. Authenticated contract renewal can charge another reservation against the daily account budget and extend that allowance, up to an absolute lifetime ceiling of eight times the recording size. Reusing a received capability cannot write a second object. A bounded prefix inspection checks actual MP4/WebM, image, audio or PDF signatures before forwarding a MIME label. These are storage/application ingress controls; upstream denial-of-service bandwidth still requires ingress protection.

There are two active reservations per account and a 10,000,000,000-byte daily account admission budget. Account scope is explicit: this is not an implemented organization pricing entitlement system. API keys currently charge their authenticated account through the same domain. A missing legacy declared size reserves the entire 250 MB ceiling. Resumable parts are at most 5 MiB, at most 48 parts, and their offsets and final total cannot exceed the actual reservation. Replacement part bytes are rejected; repeated attempts remain in cumulative ingress accounting. Completion streams each verified part into the assembled staging object rather than joining the entire recording in memory.

Direct local upload tokens and presigned S3 PUT contracts are disabled in runtime adapters. A client must use the admitted gateway. Supported mobile clients must honor `upload.received`, or use authoritative part/operation status to recover an already received upload. Capture sessions already authorized before the five-minute limit retain their historical duration ceiling; newly authorized sessions record 300,000 ms explicitly.

## Preservation and delivery

S3 commitment requires non-null staging and committed VersionIds. The candidate is hashed as a complete byte stream at its pinned staging version. Its exact version is copied to the content-addressed committed namespace; PostgreSQL saves both version identities with the immutable evidence row. ETags are never treated as full-file SHA-256 or as immutable versions. Expected capture size, type and digest are checked before promotion. An unversioned bucket fails closed.

`PACKPROOF_COMMITTED_S3_BUCKET` optionally separates committed originals and recovery envelopes from staging. New exact-version playback sends an S3 Range request for the requested bytes and returns correct 200/206/416 headers. It does not load the complete recording to serve a small range. Old rows without version references are stream-verified before delivery; this compatibility path has bounded memory but may require a full read before its first range response. A safe legacy migration remains a release task; immutable rows must not simply be rewritten.

Public media receives the same checks for original, receipt/return-stage and reviewed-derivative sources. Authorization is rechecked before response creation and every 1 MiB or one second during delivery. Chunks are capped at 64 KiB and a response has a ten-minute lifetime. Revocation stops further admission, destroys the storage stream and closes the response; already admitted network bytes cannot be recalled.

Expired cleanup requires an expired lease and checks database references under a lock. Only staging keys and their part versions can be deleted. All S3 versions of an exact expired staging key are enumerated to include interrupted responses whose VersionId never reached PostgreSQL. A copy preserved before its evidence transaction succeeds remains outside temporary cleanup; it does not establish accepted evidence without a committed recovery envelope.

## Parser and worker bounds

Primary video capture is spooled to a private temporary file through bounded buffers while verifying its complete-file SHA-256 and size. Its MP4/WebM container magic and playable video structure are checked. Linux parser subprocesses require `prlimit`, restricted protocol support, a 512 MiB address-space ceiling, CPU/time limits, limited descriptors and bounded diagnostic output. At most two capture validators run in an API process. Missing validation tools fail closed with a retryable availability error.

Thumbnail and redaction inputs use the same verified streaming spool. Redaction outputs are size-checked and uploaded as streams; original bytes are never recompressed. Subprocess limits do not establish full host isolation or independent security certification. Supporting non-capture attachments pass bounded MIME-signature inspection at the gateway. Deep structural parsing of every allowed attachment type remains a separate hardening task; it is not inferred from a matching magic header.

## Verification and release gates

The focused regression suite is `backend/tests/media-admission.test.ts`, plus object-store, evidence capture, resumable lifecycle, disclosure and capture-relay tests. It covers oversized preadmission, account concurrency/idempotency, completed-token reuse, cumulative failed-attempt charges, expired staging versus committed survival, immutable S3 VersionId selection, a 1 MiB read from a 100 MiB source, unsatisfiable ranges and revocation/lifetime during streaming. The fake S3 tests assert actual SDK command inputs; they are not a live S3 or memory-capacity measurement.

Before W03 may be marked released/observed:

- Demonstrate checksum, storage rejection, resumability and process death together on the S24 Ultra and A16 installed candidate.
- Verify actual S3 versioning, retained committed versions, Object Lock/IAM protection, routine-role denied deletion/overwrite, distinct cleanup authority and staging lifecycle against the deployed buckets.
- Rehearse short-token expiry, received-response loss, part completion response loss and exhausted ingress allowance without deleting the only local recording. Authenticated renewals must debit the same daily quota, and the lifetime cap must retain a clear intervention state while keeping the original.
- Measure ten playbacks, two commits and two exports under the candidate container limits; worker memory must remain below the plan's 70% threshold. No production capacity is inferred from the command-level range test.
- Inspect failed/abandoned versions and preservation orphans and reconcile their actual billing/storage cost.
- Complete independent parser/access review, attachment parser-depth and the deployed role/container isolation checks.
