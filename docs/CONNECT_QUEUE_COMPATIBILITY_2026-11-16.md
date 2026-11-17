# Connect 0.2.3: retained 0.2.0 queue compatibility

The user reported QUEUE_SCHEMA_UNSUPPORTED during 0.2.2 installation on November 16. Repository history identifies a release mismatch: the existing-data branch at e680cef33d86ffe6cf920c7a3740e3491872a32c shipped app 0.2.0 with queue format 2, while the UX branch’s 0.2.1/0.2.2 binaries only understood queue format 1. The user’s exact database metadata has not been inspected; the error can also represent inconsistent metadata. An app version alone cannot establish queue compatibility.

## Bounded repair

Version 0.2.3 supports the original format 1 and the exact format-2 ordinary shipment lane emitted by that 0.2.0 writer. It validates the historical tables, column types/defaults/constraints, indexes, a single integer metadata version, matching logical user_version, and every retained row’s legacy/shipment-csv/v1/grant-0 ownership. It keeps format 2 at format 2. New work in that queue retains the same legacy identity defaults. Existing originals, encrypted payloads, wire bodies, digests, receipt/idempotency identities, keys and permission bindings are preserved.

Source-specific queue rows, source drafts or approvals, and formats 3/4 remain with their source-aware collector and are rejected with explicit guidance. Those later formats protect identity/preservation permits and backfill work; this patch does not reinterpret them as ordinary shipments. Unknown protected-state/payload JSON fields survive an ordinary legacy save through extension data. Invalid, duplicated or inconsistent metadata and a downstamped format-2 layout remain rejected before queue modification.

The installer retains 0.2.2’s network-independent local readiness and bounded, redacted error display. A read-only diagnostic reports only fixed SQLite header metadata plus WAL presence/size; it explicitly warns that a main-file header may lag the logical version in WAL. SQLite read-only inspection honors WAL; it may create normal coordination sidecars but does not change queue rows, version markers, originals or keys.

## Required evidence

Portable fixtures reproduce the exact historical writer SQL, exercise encrypted pending work and restart/continued staging, and check byte and identity preservation. Negative fixtures cover source-aware work, future/mismatched/downstamped formats, extra schema objects, duplicate state aliases and a typed row committed only in WAL.

Native qualification additionally starts the packaged LocalService against a synthetic format-2 queue produced with the exact 0.2.0 migration. It verifies readiness, restart/reinstall, unchanged retained key/state/spool bytes and unchanged format-2 markers before the existing storage-repair checks run. Candidate source, artifact hashes and CI results must be recorded before delivering the new executable.

Actual Windows 11 recovery remains unconfirmed until observed on the affected PC. Do not delete ProgramData, lower a version marker, generate a replacement key over retained work, widen permissions, or grant source collection to make setup pass.
