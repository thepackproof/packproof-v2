# PackProof Security Policy

PackProof is evidence infrastructure. Security issues that could alter, impersonate, disclose, suppress, or misrepresent a Proof or its evidence are treated as integrity-critical.

## Supported code

Security fixes are developed against the current default branch and the active release candidate. Historical builds are not independently maintained unless explicitly designated as supported.

## Reporting a vulnerability

Do not open a public GitHub issue for a vulnerability that could expose credentials, personal information, unpublished evidence, signing material, or a practical integrity bypass.

Use GitHub's private vulnerability reporting feature for this repository when available. If private reporting is unavailable, contact the PackProof repository owner through the private company contact channel and include:

- the affected component and release/commit;
- reproduction steps;
- expected and observed behavior;
- potential impact;
- whether credentials, personal data, or evidence content were accessed.

Do not include production secrets or third-party personal data in a report unless strictly necessary to demonstrate the issue.

## Integrity-sensitive boundaries

Changes to the following areas require particular review and regression coverage:

- canonical manifest construction and hashing;
- evidence upload, validation, commit, storage, and retrieval;
- finalization and post-finalization mutation guards;
- workflow protocol semantics and versions;
- authentication, participant authorization, invitations, and public access links;
- external transaction identity and provider provenance;
- provider webhook authentication;
- signing and verification material;
- database migrations and infrastructure policies affecting evidence durability.

A client must never become authoritative for Proof state, evidence validation, finalization, provider provenance, or integrity results.

## Secrets

Never commit provider credentials, OAuth tokens, AWS credentials, Cognito secrets, signing keys, webhook secrets, database passwords, or production environment files. Server-side credentials belong in the configured secret store; clients receive only the minimum public configuration required to operate.
