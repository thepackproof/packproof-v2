# Capture platform implementation — 9 September 2026

Governing source: `PackProof_Capture_Technology_Comprehensive_Development_Plan_2026-09-08.docx`, supplied by Collin. Base: Android order-intake candidate 0.3.11 (40), commit `dd3200384832cbddfc0a362a22f594bf80f1960b`.

## Release decision

This is a **foundation candidate, not completion of the entire development plan**. It must not be described as production-qualified PackProof Capture. Default Android/browser entry points keep the existing capture protocol. To exercise the candidate explicitly, set `EXPO_PUBLIC_PACKPROOF_CAPTURE_ENGINE=1` / `VITE_PACKPROOF_CAPTURE_ENGINE=1`, or open a new server-issued CaptureIntent on a build containing the new adapter. Existing capture links/proofs continue to work. Deploy migration 058 and the new API before testing candidate clients.

The attached plan orders the work by release gates. Gate B cannot pass with the current CameraX MP4 writer: a finalized original and its native journal survive bridge loss, but a force-stop during active encoding can leave an unplayable tail. This implementation explicitly sets `incrementalMedia:false` on Android. It does not manufacture segment durability or certification. A fragmented media writer with retained completed fragments, plus real-device validation, is required before promotion. iOS, native warehouse and public native SDK rollout remain after that gate.

## Implemented candidate

- One pure, deterministic Capture Core, imported by server, Android React Native adapter and browser. Schema `packproof.capture/1`; version `1.0.0`; strict normalized records, state transition contract, label comparison, requirement evaluation and single-prompt arbitration. No runtime ML service, network or camera dependencies in the core.
- Authenticated, expiring, single-use CaptureIntents. Only token digests are stored. Proof, actor, context, policy and capabilities are frozen. Order changes between issue and redemption require a new intent. A link carries only an opaque fragment token; no order PII or API key is placed in it.
- PostgreSQL immutable capture bindings, receive-only journal batches with exact idempotent retry, sealed manifests and append-only audit. Frozen originals and historical manifests are not rewritten.
- Domain-separated ordered media commitments and event roots. The server recomputes manifest contents and source segment hashes while consuming the immutable original stream. Declaration of a chunk receipt is explicitly separate from byte validation. A new-protocol original cannot commit before its manifest is sealed.
- New manifest roots are included in seller signature challenges and in the final signed canonical Proof. Local challenge validation checks the expected capture root. Existing biometric authorization and no-raw-biometric behavior remain in place.
- Native Android context binding before recording; serial fsync event journal outside the camera/main/analysis executors; durable completion marker after journal flush; explicit interruption reasons; native storage reserve check; FHD preferred with device fallback; analysis throttling under severe thermal load. Barcode confidence is recorded as unavailable, not invented from a consensus count.
- Browser chunk bytes and commitments saved atomically in IndexedDB. Recovery reconstructs and hashes each original chunk for the same server/account/capture, preserves interruption and requires operator confirmation. Successful delivery archives the original before removing the duplicate engine queue. Capture does not silently enable audio.
- Android and browser launch routing; one-time native/browser choice; authenticated same-account handoff; browser recovery attached to original Proof. Direct launch does not require manually reconstructing an order.
- Reviewer Capture Capsule with machine/device event provenance, capability limitations and source-video seeking, using the existing evidence player and access checks.
- Private server host SDK for storefront/WMS launch actions, using existing tenant scopes/rate limits and encrypted idempotent responses. Receipt verifier requires a trusted signing key and checks the signed Proof, capture ID and manifest root. No unrequested external callback/network destination is accepted.
- Recovery snapshot/export and restore table coverage for intents, sealed engine records and journal batches.

## Architectural decisions

**Reuse the canonical evidence backend.** Capture UI state does not become Proof lifecycle state. Media upload, immutable object promotion, content probing, participant authority, attestation, durable preservation and finalization continue through the existing domain commands. Camera intelligence is supplementary to the canonical source.

**Use the existing TypeScript runtime for the first shared core.** The plan recommends Rust rather than mandating it. A TypeScript core avoids a second native toolchain while publishing the contract. It is imported unchanged by the current three runtimes. A native Rust/WASM harness, AAR and Swift Package distribution have not been produced; those portability/certification gates remain open. Native capture/journaling is outside React state; the pure requirement evaluator currently runs in the JS runtime.

**Disclose missing evidence.** No released item/package-state detector or surface fingerprint exists in this candidate. Item visibility is declared unavailable and is not satisfied by generic image brightness, a fake box heuristic, a barcode or a button press. Barcode detector outputs retain model/version/configuration and an explicit uncalibrated status. Unknown model IDs and machine-written device/operator events are rejected. A lack of mismatch warnings never becomes “order verified.”

**No automatic production rollout.** Missing hardware/media qualification is a concrete integrity risk, not an approval formality. The candidate is kept reviewable behind launch/feature boundaries; no database migration, live API release, website publication, Play upload or signed AAB release is asserted by this implementation.

## Requirement coverage

| Requirements | Candidate coverage / remaining work |
|---|---|
| CTX-001–003 | Implemented intent redemption, immutable binding, minimized fragment links. |
| CTX-004 | Expected tracking, item SKU and quantity with source/snapshot digest. SKU context is not claimed as observed product identity. |
| MED-001 | Existing Android CameraX simultaneous recording/analysis extended; iOS native adapter pending. |
| MED-002–003 | First-party live camera entry only; declared integrated/unknown source. Client claims remain untrusted device-origin assertions. |
| MED-004 | Existing original-preserving media admission/playback pipeline reused; no new transcode policy introduced. |
| MED-005 | Candidate audio off; schema/policy reject silent enablement. Merchant audio override UI pending. |
| INT-001 | Browser atomic chunks implemented. Android full-file sealing only; live fragment survival is a release blocker. |
| INT-002–004 | Ordered commitments, normalized timing, native event fsync and browser journal. Native active-encoder crash qualification pending. |
| OBS-001–004 | Shared observation schema, model provenance and isolated native/browser barcode analysis. New item/package models pending. |
| LBL-001–003 | Passive recognition and conservative multi-label conflict. Existing server label-resolution flow retained. |
| LBL-004 | Tracking-only extraction; no full-address OCR index. |
| SUF-001–004 | Pure versioned evaluator, deterministic support, unavailable/missing/conflict distinction, one prompt. V1 item visibility cannot pass until a calibrated detector is supplied. |
| SUF-005 | Policy contract exists; no production risk-adaptive policy rollout. |
| UX-001–004 | Candidate Android local guidance and ephemeral match acknowledgment; browser retains existing nonmodal label flow. Real operator qualification pending. |
| CON-001 | Explicit native lifecycle/error/storage events and browser interruption disclosure. Process death is not hidden as continuity. |
| CON-002–003 | Advanced liveness and app-integrity verification not implemented; unavailable signal disclosed. |
| FPR-001–004 | Production guardrails enforced by model/type allowlists. Dataset/quality-gated physical fingerprint R&D pending. |
| OPS-001–004 | Expected item-set context, wrong-label warning, conservative ambiguity. Item-count perception and calibrated correction hints pending. |
| ATT-001–003 | Versioned existing statement; Android OS-mediated signature; signature includes capture root. Hardware certificate chain/App Attest verification pending. |
| ATT-004 | Actual capability class declared. New device-credential/iOS fallback and fully offline attestation signing pending. |
| CMP-001–004 | Deterministic event capsule and source seek; existing original-derived thumbnail path retained. Unverified client derivations rejected; no generated source evidence. |
| PRV-001–003 | Original/reviewer separation and existing access/retention reused; no face recognition or generative evidence. New PII-aware redaction detector pending. |
| OFF-001–004 | Recording after bind works offline; same-account durable recovery/upload reused. Android active recording fragmentation and fully offline final attestation remain open. |

All table prefixes are `CAP-`. “Pending” means not implemented or not qualified, not implicitly complete.

## Release gates and next concrete work

1. **Foundation A:** shared JS/server/browser logic and tamper tests implemented. Native/WASM conformance harness, schema publication and full crash qualification remain.
2. **Reference B:** compile the native candidate, then test Galaxy S24 Ultra and A16 5G. Implement a fragmented Android encoder/muxer without hidden gaps before claiming force-stop segment recovery. Measure cold/warm preview, recording/analysis stalls, storage pressure, thermal behavior and biometric cancellation/replay.
3. **Sufficiency C:** curate licensed/consented representative packing footage. Release an item/package visibility detector only after precision/recall and false-warning thresholds are defined and measured. The policy must then require genuine supported observations.
4. **Embedded E:** exercise one real merchant tenant end to end, including QR-to-phone, login, expired/reused token, same-order return and receipt verification. A host SDK contract is implemented; no native Shopify Admin extension install or partner certification has occurred.
5. **iOS D / warehouse F:** implement their native adapters after the reference gate. Preserve one context/journal/manifest contract and explicit unavailable capabilities. No claim of cross-platform certification.
6. **Advanced G:** maintain experimental scope for package fingerprint, continuity/liveness analysis, item-count hints, redaction and C2PA. No accuracy data, patentability result or fraud-detection claim is invented.

## Verification record

Local checks run in this turn:

- Backend typecheck passed.
- Android/React Native TypeScript check passed; this is not Kotlin compilation or physical-device validation.
- Browser production build passed.
- Focused backend capture/attestation/relay checks: 24 passed.
- Focused browser journal/camera/reviewer checks: 13 passed.
- Host SDK request and signed-receipt checks: 2 passed.

Later checks and remote CI results are recorded in the delivery response/PR. No live service or device behavior is inferred from these local passes.

Technical references checked during implementation: [CameraX nonblocking image analysis](https://developer.android.com/media/camera/camerax/analyze), [MediaRecorder chunk delivery](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/start). Chunk arrival time is not a frame presentation timestamp. Browser source/camera integrity is not independently attested.
