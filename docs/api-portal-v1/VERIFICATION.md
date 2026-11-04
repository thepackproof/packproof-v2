# Portable verification and report contract

The API and portal use the existing immutable Proof manifests and portable
package formats. The signed envelope remains an explicitly gated engineering
profile. This release does not enable signing, grant new service-principal
attestation authority, change protected-storage policy, or rewrite historical
manifest bytes.

## Independent recipient workflow

1. Obtain the verifier from an authenticated PackProof release channel, separately
   from the evidence package. For the additive ES256 profile obtain `verify.py`,
   `envelope.py`, and the pinned dependencies in `requirements-envelope.txt` from
   that same release.
2. Obtain the expected Proof identity and manifest digest through the agreed
   independent channel. Obtain the issuer's public key history independently;
   a key or URL supplied by the package cannot establish its own trust.
3. Run the offline verification with those required inputs:

   ```sh
   python verifier/verify.py shipment.pkpr \
     --envelope-trust independently-authenticated-issuer-keys.json \
     --expected-proof-id proof_example \
     --expected-manifest-sha256 <independently-known-64-character-sha256> \
     --html-report shipment-verification.html
   ```

4. Inspect the separate findings in the JSON output and the static HTML report.
   Keep the original package, independently trusted public material, and verifier
   release so the check can be reproduced. The report is an unsigned presentation
   of a local check; it is not a replacement for the evidence package.

On Windows, use the installed Python executable or `py` launcher in place of
`python`. Existing report paths are never overwritten. The verifier neither
extracts package entries nor opens network connections or executes package
contents. The report embeds no media, scripts, external assets, or archive links.

## Findings remain independent

| Finding | Meaning | Does not establish |
| --- | --- | --- |
| File integrity | Included bytes match the signed SHA-256 and byte count. | Accuracy of the depicted event or source claim. |
| Issuer signature mathematics | The signature verifies under the supplied matching public key. | Current trust in a compromised/revoked key. |
| Declared coverage | The files match the signed inventory for this received scope. | That no later or otherwise unseen evidence exists. |
| Key trust and trust freshness | The independently supplied key history permits this reported issue time and remains within its review period. | Online revocation knowledge after that snapshot. |
| Independent timestamp | Presence and supported verification state of an independent timestamp. | That issuer time is physical capture time. |
| Truth of recorded scene | `NOT_ASSESSED`. | Condition, contents, location, liability, or a truthful human assertion. |

The report identifies the signed Proof, record type and record ID, attributed
issuer, and issuer-reported time. Each included file shows its expected digest,
expected bytes and actual received bytes. Changed files, missing included files,
and intentional omissions have separate sections. An original file's digest can
match while the overall package remains untrusted or incomplete.

The existing package authenticates its frozen captured-evidence/core snapshot
and the signed extensions it explicitly declares. The new records dashboard's
operational lifecycle, entity relationships, requirement evaluations, issue
resolutions and operational amendments live in separate tables. They are not
included in or authenticated by the existing core/envelope package. An API
read or operational summary must not be advertised as a signed operational
snapshot. Covering those fields requires an explicit versioned signed extension
and independent verification of that extension.
The implementation and deployment prerequisites are recorded in
[OPERATIONAL_SNAPSHOT_GATES.md](OPERATIONAL_SNAPSHOT_GATES.md). The signed
operational snapshot capability remains unavailable.

`COMPLETE_FOR_DECLARED_SCOPE` is cryptographic package coverage. It is distinct
from the operational requirement evaluation shown by the portal. It must not be
rendered as “shipment complete” or a passed physical-condition check. There is no
new claim of an independently trusted timestamp: the existing exporter emits
`NOT_PRESENT`; unsupported trusted-time assertions remain rejected.

## Compatibility and bounds

- Legacy package v1, disclosure packages, signed supplement chains and their
  original trust options retain their existing definitions.
- The additive v2 ZIP descriptor, artifact membership, canonical envelope,
  coverage declaration and signature inputs are unchanged. No uncovered report
  member is appended to the ZIP; the offline report is generated separately.
- The existing 220 MiB ZIP transport cap and 200 MiB frozen-manifest/original
  admission budget remain unchanged.
- The result adds signed `recordType`, `recordId`, `issuer`, and `issuedAt`, plus
  per-file `kind`, `expectedByteSize`, and `actualByteSize`. Missing files have
  `actualByteSize: null`. These fields describe existing signed claims and actual
  local bytes; they do not upgrade assurance.

## Release evidence and remaining gates

`verifier/test_envelope_report.py` checks the existing recorded synthetic signed
package, altered bytes, missing originals, compromised-key qualification,
separate report dimensions, inert untrusted text, and input-overwrite protection.
The cross-language envelope suite continues to test independently produced
signatures and legacy compatibility.

Production activation still requires the actual authenticated HTTP, key-history
distribution, workload-role, exact-version preservation, retention, recovery and
merchant-cohort acceptance described in
[ENVELOPE-PROFILE.md](../partner-foundation/ENVELOPE-PROFILE.md). Report tests are
engineering evidence and do not satisfy those deployment or customer gates.
