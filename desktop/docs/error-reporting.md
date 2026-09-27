# Desktop error reporting

Centralized reporting is optional and disabled unless the release includes a
valid public Sentry project DSN through `PACKPROOF_SENTRY_DSN` (or `SENTRY_DSN`).
The public DSN identifies the destination project; no Sentry management token
belongs in an installer. Development builds never send reports. Runtime state
distinguishes unconfigured, invalid, disabled and active reporting.

Only the fixed categories and codes in `src/main/error-reporting.ts` can be sent.
Reports contain a static error label, application version, release channel,
operating-system family and a random event ID. Duplicate codes are limited to
one per minute per process. They contain no account, Proof, order, tracking,
camera, installation or evidence identifiers; no exception messages, stacks,
filesystem paths, requests, tokens, recordings or attachments are accepted.

The main process uses an isolated `@sentry/node` client pinned in the lockfile.
No global Sentry initialization or automatic instrumentation runs. Data
collection, local-variable capture, hostname collection, breadcrumbs, client
reports, request instrumentation, logs, metrics and tracing are disabled.
The final event filter reconstructs the report from allowed fields, discarding
any unrelated SDK or global-scope context. Shutdown reporting is bounded and
reporting failure never blocks evidence preservation.

Operators should provision a PackProof-owned Sentry project, set the public DSN
in the protected staging release configuration, trigger one coded test failure
and confirm its fields in that project before production activation. There is
no configured project or certified delivery until that operational check is
complete. Local redacted diagnostics remain available without Sentry.

SDK references:

- https://docs.sentry.io/platforms/javascript/guides/node/configuration/options/
- https://docs.sentry.io/platforms/javascript/guides/node/configuration/filtering/
- https://github.com/getsentry/sentry-javascript/blob/develop/MIGRATION.md#senddefaultpii-is-replaced-by-datacollection
