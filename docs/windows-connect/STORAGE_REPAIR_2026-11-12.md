# Connect storage readiness repair — 2026-11-12

## Why

A Windows 11 operator reported LOCAL_STORAGE_UNAVAILABLE despite a running LocalService, correct root-directory ACLs and retained state/key/SQLite files. Those facts do not identify the failing operation or prove the descendants are accessible. The screenshot's message came from the general command I/O handler; source-folder failures could be mislabeled as protected-storage failures. Do not claim a machine-specific root cause without a reproduced failure or a precise diagnostic.

## Changes

- Strict protected reads distinguish a genuinely missing file from denied or locked existing data; no File.Exists-based state/key reset.
- Root and spool readiness exercise disposable write, durable replacement, readback and removal, under the actual service identity. No evidence/key/state file is used as a write probe.
- Windows sharing violations receive two bounded retries and specific error codes. Other I/O failures identify the operation and native code without exposing exception paths.
- An administrator-only, NETWORK-denied local readiness endpoint answers a fresh challenge. The installer verifies its peer PID against the registered LocalService and quoted installed binary before accepting its result. It cannot enroll, upload or change collection settings.
- Installation success requires actual DPAPI, retained key/state access, storage/spool I/O, SQLite quick-check/writer-lock acquisition and disk reserve, not merely SCM Running.
- Reinstall validates retained descendants and repairs only the known private storage tree with trusted owners. It refuses reparse points, hard links, unexpected owners, explicit deny rules and unknown layouts. Keys, queued originals and state bytes are not deleted or regenerated. Shared-parent permissions are not changed.
- Source I/O errors stay in the source domain. The chooser starts at the prepared export folder and offers that folder only after explicit operator consent. No personal folder ACL is weakened and no files are moved or uploaded.
- Failed native qualification publishes diagnostic receipts only, never a downloadable executable.

## Verification scope

New unit and hosted-native fault-injection tests cover locked state/key material, missing keys with retained queues, descendant ACL drift, source-domain errors, hard-link refusal, preservation and reinstallation. Existing foundation tests still cover actual LocalService DPAPI, restart, operator preservation, standard-user access, counterfeit peer rejection and uninstall retention.

CI completion must be recorded before claiming the repair build passed. Hosted Windows Server tests are not Windows 11 interactive NSIS/UAC acceptance, a full app login/import canary, or production signing. The hosted approval compatibility check from PR 160 remains in place. No backend, database, DNS or web deployment is required by this local repair.
