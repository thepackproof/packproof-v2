# Shared identifier parsing and recovery

The API, Android and web use `backend/src/identifiers/{types,core,journal}.ts`. Runtime modules have no Node imports, network calls, decoder APIs, database access or dependency on `Buffer`/`TextEncoder`. The server remains authoritative for shipping, tenant/store product resolution and material review.

## Pinned resources

- [GS1 Barcode Syntax Dictionary, revision c63d8a12210dd0cfaceac4aae45ccf57b48eb15b](https://github.com/gs1/gs1-syntax-dictionary/blob/c63d8a12210dd0cfaceac4aae45ccf57b48eb15b/gs1-syntax-dictionary.txt), retrieved 9 September 2026. Exact source is vendored with its Apache-2.0 license under `backend/src/identifiers/gs1/`. SHA-256: `a3a7830ffdeaf182783c8bbb34947c85394167012b81c91d84b6e0c82e40d170`.
- `gs1/dictionary.ts` is a compact generated representation of all 224 resource rows, including range expansion, component lengths, separator flags, required/excluded AI associations and Digital Link qualifier sequences. The fixture verifies the vendored resource hash.
- UPC-E expansion is checked against [ZXing 3.5.3 UPCEReader](https://github.com/zxing/zxing/blob/zxing-3.5.3/core/src/main/java/com/google/zxing/oned/UPCEReader.java). Fixtures exercise all expansion branches and number systems 0 and 1. Missing number-system/check digits are not invented.

## Capability contract

| Input | Shared interpretation | Limits |
| --- | --- | --- |
| UPC-A, UPC-E, EAN-8, EAN-13 | Validated GTIN normalized to 14 digits | Invalid product symbols remain invalid product observations; never fall through to shipping |
| ITF-14; valid 14-digit ITF | Validated packaging-level GTIN | Packaging indicator remains significant |
| Code 128/39/93, QR, Data Matrix, ITF, Codabar, PDF417, Aztec | Exact opaque value for scoped resolver | Format alone does not establish SKU, tracking, serial or order meaning |
| Explicit GS1 AIM/FNC1, HRI, GS1 format | Resource-driven AI boundaries and associations | Typed fields: 00 SSCC, 01 GTIN, 02 contained GTIN, 10 lot, 17 expiry, 21 serial |
| Numeric-AI uncompressed GS1 Digital Link | Offline path/query parsing using dictionary associations | Compression/short-name aliases are not supported; non-GS1 query parameters, fragments or credentials are suppressed |
| Other AIs | Bounded UNKNOWN/UNSUPPORTED attributes | No product binding or field autofill from unsupported attributes |
| Other symbologies | Unsupported observation | Decoder support and physical qualification remain separate release gates |

This is an explicitly limited GS1 parser, not a GS1 certification implementation. It applies numeric/CSET field shape, GTIN/SSCC check digits, expiry-date validation and AI associations needed by the typed subset. It does not verify GS1 company-prefix ownership, execute all upstream linters for unsupported attributes, or assert product authenticity. Missing required associations mark a typed value UNVERIFIED. Malformed boundaries, duplicate AIs and exclusive combinations cannot produce trusted identifiers. A variable-length field without FNC1 consumes the remaining element string; the parser never guesses a new AI inside its value. Expiry stays in the observed YYMMDD form, including permitted day zero.

Decoders must preserve a GS1 AIM identifier or FNC1 when available. A numeric Code 128 value lacking structured markers remains opaque, even if it resembles a GS1 element string. Raw UPC-A reported as a zero-prefixed EAN-13 compares correctly.

## Recovery and persistence

`IdentifierJournal.observe()` sanitizes sensitive/unrelated QR payloads and durably writes an immutable event before transport. `flush()` sends only unacknowledged IDs, with one request in flight. Batch limits are 50 events and 128 KiB; the session limit is 512 events, with the final 32 slots reserved for opaque candidates so product noise cannot consume all potential shipping-observation capacity. The existing shipping queue retains its independent protections.

Repeated identical payload/symbology sightings coalesce to the first persisted detection. Its time and `sightings=1` describe that observation, not the number of items packed. Distinct serial payloads remain distinct. Accepted event bodies are never edited to update a counter. Omitted distinct events and failures downgrade coverage explicitly.

The journal uses bounded exponential backoff with jitter between explicit flush calls; it does not sleep or auto-retry per frame. An unstructured 404/405 or explicit optional-capability-unavailable response stops transport for that handle, preserving its journal for recovery. Adapters must supply their normal bounded HTTP timeout in `send()`. `drain()` waits only for local persistence at Stop. `updateReview()` stores authoritative decisions, and `setCheckpointEventId()` durably stores the caller's stable checkpoint operation ID. The existing completion coordinator owns the checkpoint request and single attestation flow.

Account/API scope is asserted before writes and before/after transport. Storage or optional network outages preserve pending IDs and known server review. Authentication, scope, idempotency and material conflicts propagate. Old clients/sessions never instantiate this optional journal unless their pinned policy enables it.

`sanitizeIdentifierPayload()` must also run at authoritative server ingress. It clears raw bytes with a suppressed payload. Full raw values belong only in the protected evidence journal, never general logs or public disclosure.

## Focused checks

Run `npm test -- --run tests/identifier-core.test.ts tests/identifier-journal.test.ts` from `backend/`. The fixture pack covers GTIN/UPC-E, mixed product/opaque routing, GS1/FNC1/Digital Link, hostile QR minimization, resource pinning, persistence-before-send, restart/lost-response replay, partial acknowledgment, byte/count caps, reserved capacity, scope changes, material conflicts and flag-off behavior.

Physical decoder accuracy, recording performance, source-backed catalog lookup and finalization invariants require their separate integration/pilot gates. Unit fixtures do not certify a device or browser.
