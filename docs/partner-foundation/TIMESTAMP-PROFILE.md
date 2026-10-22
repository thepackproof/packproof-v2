# RFC 3161 timestamp implementation

This additive implementation addresses C03-03. Its message imprint is exactly
SHA-256 of RFC 8785 canonical JSON for the complete flattened JWS object,
including protected header, payload and signature. An issuer signature and a
timestamp have separate validation results. Neither establishes capture time or
the truth of a recorded scene.

The caller creates one request with a 127-bit random nonce, explicit policy OID
and certificate request. It must preserve that request before transport and reuse
the same bytes on retries. The explicit HTTPS transport pins a public DNS answer,
retains normal hostname/certificate checks, refuses redirects and limits request,
response and elapsed time. No provider is selected or enabled by default.

Validation checks the response status, imprint, nonce, policy, time, bounded CMS
shape and independently pinned signer. OpenSSL `ts -verify` then checks the CMS
signature, ESS certificate binding, timestamp EKU, certificate chain and request.
The certificate path is checked at token generation time. Fresh, separately
authenticated root and signer pins plus a reviewed revocation snapshot are
required at verification time. Archive certificates never establish trust.

The stored material contains the exact DER request and response (the latter
includes the CMS token and certificate material), SHA-256 algorithm/imprint,
validation result, generation time, serial, certificate hashes and trust-policy
hash. Revalidation must use fresh independent trust; a stored `VALID` string is
not authority. Offline output must identify revocation knowledge as a reviewed
snapshot. PENDING, failed and absent timestamps cannot be described as trusted.

Source references: [RFC 3161](https://www.rfc-editor.org/rfc/rfc3161),
[OpenSSL ts](https://docs.openssl.org/3.4/man1/openssl-ts/) and
[OpenSSL explicit certificate store construction](https://github.com/openssl/openssl/blob/openssl-3.4/apps/ts.c).

Current scope: bounded protocol and transport, package export and independent
Python verification are implemented. Source `d792384a5173408ca01087f1d6168e3361ce90c6`
passed all 22 Linux timestamp conformance checks, including real OpenSSL tokens,
wrong nonces, signature tampering, unrelated roots, revoked trust, cross-language
verification and a complete exported package. Full CI passed 1,535 backend checks
(17 skipped), web/mobile, PostgreSQL invariants and security gates. The Windows
host cannot execute MSYS OpenSSL; the cryptographic result comes from Linux CI.

Durable request/result persistence, worker scheduling, runtime/HTTP integration,
container packaging and deployed acceptance remain open in draft PR #126. No
production configuration, service, migration or provider has been changed. See
[the engineering checkpoint](m2-envelope-engineering-checkpoint-2026-10-22.json).

Verifier v1.5.0 accepts `--timestamp-trust` separately from `--envelope-trust`.
A package declares timestamp material PRESENT; the verifier derives VALID or
INVALID. A claimed historical validation receipt never supplies current trust.
Missing or untrusted timestamp material makes a declared timestamp invalid while
preserving the separate issuer-signature and media-integrity results.
