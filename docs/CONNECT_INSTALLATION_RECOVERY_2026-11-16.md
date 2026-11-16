# Connect 0.2.2 installation recovery candidate

The user reported that the unsigned Connect 0.2.1 development installer stopped with its generic installation/protected-storage readiness dialog on November 16, 2026. That dialog alone does not identify the underlying failed check. Matching hosted API, worker and browser deployment has been verified separately; it does not establish successful local installation.

Two independently confirmed defects are corrected in this candidate:

- The interactive installer inherited disabled detail printing, so its failure dialog pointed to details that could omit the actual error. Setup now restores visible details and shows a bounded, redacted check code and phase. Known local failures retain their codes; unknown failures use fixed phase-specific guidance. Raw exceptions, credentials and report contents are excluded.
- Installation readiness called the ordinary status command, which shared a gate with authenticated background cloud work. An already enrolled PC could therefore time out on local readiness while a cloud request held the gate. Installer admission now reads constructor-owned local initialization state without that gate or source enumeration. It still performs all current LocalService identity, protected-storage/DPAPI, retained-key/state, spool, SQLite integrity/writer-lock and disk-reserve checks.

The regression holds a real enrolled heartbeat open, proves ordinary status is blocked, and verifies that the separate local initialization guard completes promptly without changing retained state, key, token, pause flag or spool contents. A partial/uninitialized runtime remains rejected. The existing native storage and peer/ACL checks remain required.

Application, service and bridge advance together to 0.2.2. A read-only PowerShell diagnostic is included in the installed resources/installer folder. It reports bounded host, service, registration, permissions and selected local-status facts; it does not rerun installation, repair ACLs, access protected contents or keys, request enrollment/collection, or invoke the storage-writing readiness probe.

## Qualification boundary

The specific cause of the user’s 0.2.1 failure remains unknown until diagnostic evidence or a successful repair is observed. These fixes must not be described as proof that that machine has recovered. Candidate CI, artifact source/hashes and native smoke results must be recorded before delivering 0.2.2. Actual Windows 11 installation/upgrade with retained work, authenticated first Proof and second unattended export, installed accessibility/usability, signing and rollback rehearsal remain open.

Preserve ProgramData, encrypted originals, queue/journals and encryption keys. Do not reset storage, reinterpret pending originals, widen operator/service authority or enable collection to make installation pass.
