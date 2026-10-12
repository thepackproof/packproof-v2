# Experimental operations and rollback

## Local startup and distribution interlock

Use `config/rnd/local.env.example` as a reference for a deliberately isolated local environment. It contains no credentials. Do not source an existing production environment to fill missing variables. Runtime adapters must reject production endpoints/keys when the research mode is active; source CI interlocks do not replace runtime isolation.

`node scripts/rnd-release-guard.mjs` must report `allowed: false` for this source. `node scripts/rnd-release-guard.mjs --enforce` must exit with failure. This is an intentional distribution denial, not a failing feature test. No app-store upload, signed distribution, Expo update, deployment or updater publication is part of R&D implementation.

CI preflight is a read-only reusable job without signing/cloud secrets. Distribution jobs require its explicit `allowed=true` output and reject `rnd/` branch refs. The source marker blocks renamed/copied/merged research builds. Future release would require a separately reviewed change of source metadata, exact code/build/qualified scope, authorization, and rollback owner; changing a repository variable alone is insufficient.

## Four controls and kill switch

Each feature has independently default-off collection, processing, internal-display and customer-display controls. Enable only the needed consented internal experiments after source authorization. Collection does not authorize training. Customer display remains disabled until named-scope qualification and separate release authorization.

On byte-integrity break, cross-tenant access, original-media loss, unsafe illumination, redaction leak, repeatable in-scope bypass or privacy-budget violation: stop affected optional processing/display immediately; preserve original capture, committed results and audit. Disable feature configuration/model route or the isolated build, then reconcile pending jobs. Never rewrite roots or prior findings to conceal the incident. Abort/restore camera control leases without restarting the recording.

## Keys, source access and witness policy

Maintain separate inventories for client/session keys, platform attestation, server signatures, test witness keys and ZK verification keys. Record ID, algorithm, validity, rotation, revocation and policy. Unknown/revoked keys never receive trusted status. Development keys remain local/private and are excluded from Git, exports and logs; exports receive public verification material only.

Every artifact URL/export checks authorized tenant/participant/leg. Keep request bodies, private crops, OCR/address text, unrestricted URLs and model updates out of telemetry. Witness publication uses fresh blinded commitments only; authorized bundles receive their own opening material. Internal witness processes are test-only. External reliance requires two named independent operators, both required by the pinned policy; outages result in pending states, not silently reduced requirements.

## Consent and retention

Stage packages or use explicitly consented partner captures. Record purpose/version, data subjects, retention, permitted model use and withdrawal. Withdrawal stops future learning. Do not promise removal of already aggregated influence. Ordinary evidence use is not permission for cross-merchant training.

Existing source policy has minimum 90-day protection and no automatic deletion. Do not convert this to a 90-day expiry or enable S3 Object Lock/legal holds. Research originals, descriptors, derivatives, exports and model datasets need explicit authorized lifecycle policies. When source bytes are lawfully removed, retain permitted audit/integrity metadata and say reproduction is unavailable. Downloaded exports cannot be recalled by revoking a link.

## Resource and incident observations

Measure recording interruption, queue recovery, commit/hash mismatch, denied tenant access, optional error/abstention, supported coverage, witness lag, privacy expenditure, redaction leaks and attributable unit cost. Log opaque IDs/counts. Record feature-off/on device and runtime baselines before setting performance-derived thresholds. Integrity/privacy incidents alert immediately; experimental numeric targets are not achieved performance.

Bound CPU/memory/runtime/input bytes/retries/concurrency per feature. Shared capture/storage costs count once, while failure and retry costs remain in total cost per success. 3D/ZK jobs remain separate bounded research processes. No permanent GPU service or external LLM is required.

## Recovery rehearsal

Exercise worker disabled, expired lease, duplicate delivery, crash before/after outbox commit, delayed sidecar, key rotation, missing witness and unavailable model. Verify original Proof still commits/finalizes, no duplicate extension appears, and late sources keep actual receipt times. Restore model/configuration to the prior immutable release; never roll back data by deleting new extensions. Hardware recording recovery requires real-device evidence, distinct from software transaction fixtures.
