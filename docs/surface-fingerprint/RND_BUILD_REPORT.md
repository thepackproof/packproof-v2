# PackProof stochastic surface fingerprinting — R&D build report

Report snapshot: October 1, 2026. This is an experimental implementation and build record. **No real physical corpus has been collected and no phone, print process, material or device pair is qualified.** The application deliberately cannot issue customer-visible physical consistency or difference findings.

Application source: `3637c5038b564fe432d8f218ed731a837301b2c6` on `rnd/stochastic-surface-2026-10-01`. Android build-workflow correction: `1f72154fe6a69b4f78565892a385a1aadc1d1254`. The correction replaces obsolete Android SDK tooling; it does not introduce a new matching method.

No build was submitted to Google Play, App Store Connect, TestFlight or another distribution platform. No production backend, website, update feed or OTA release was deployed. The research workflow only compiles and retains build artifacts. Existing application review submissions remain outside this work.

## Implemented research scope

| Area | Implemented behavior | Boundary |
| --- | --- | --- |
| Native capture | Optional sampling inside the existing Android CameraX and iOS AVFoundation camera owners; bounded selected frame files, timing, barcode association, continuity metadata and local recovery journal | A compiled adapter does not establish uninterrupted camera operation or useful optical detail on real hardware |
| Enrollment and later observation | Server-authorized, Proof/package/leg-bound source commitments; expected enrollment selection; live/offline/supplemental provenance and explicit assurance limits | Barcode identity selects the expected transaction; it does not contribute physical identity evidence |
| Backend | Additive tables; exact upload hashes and committed object versions; request-digest intents; idempotency conflicts; quotas; leased worker jobs; audited reads/attempts; append-only records and linked reanalysis | The ordinary packing Proof and frozen root remain independent of optional analysis |
| Classical worker | CPU registration with bounded transforms; print-layout/illumination suppression; experimental residual/substrate descriptors; quality masks; typed print/carton/context coverage; private diagnostics | The method has no calibrated thresholds and does not establish physical-instance discriminability |
| Region discovery | Same-frame barcode hints and bounded label-outline search propose candidate print/carton/context regions; uncertain geometry abstains | Carton/material associations remain unverified proposals, not authenticated package identity |
| Reviewer experience | Experimental opt-in views across mobile, web and desktop; separate label/carton/assembly scope, source references, missing coverage and operational states | No overall verified/authentic badge, public raw scores or probability-of-fraud claim |
| Integrity and export | Frozen-root references, exact canonical result/template strings, append-only extension chain, authorized original downloads and independent offline verifier | Default participant exports withhold private templates; omissions remain explicit |
| Research harness | Empty real-corpus manifest, split/leakage checks, frozen evaluation configuration, ablations, independent truth join, scoped metrics and cost/rollback templates | Synthetic fixtures validate software only; they are never counted as physical trials |
| Build isolation | Separate R&D app identities/storage/scheme, local development accounts, loopback API defaults, no update feeds or production account fallback | These applications need the isolated research backend; installers do not bundle a production service |

Automatic RETURN sampling remains disabled because the current return-capture context does not provide an authoritative return tracking identifier. The backend has explicit shipment-leg bindings, but this missing mobile binding is not silently replaced with an outbound identifier. Learned matching, calibrated angular/illumination inference, Play Integrity and App Attest qualification remain outside the implemented baseline.

## Actual software validation

The following are distinct suites and checks. Counts overlap in their covered behavior and must not be combined into a single “all tests” total.

| Check | Observed result | What it establishes |
| --- | --- | --- |
| Worker regression suite | 19 tests passed | Synthetic image processing, real CLI execution, bounds, geometry/coverage handling, deterministic replay, dataset leakage checks and conservative outcomes |
| Offline surface verifier | 15 tests passed | Root/head/tenant binding, exact bytes, template/result substitution, omissions, source tampering, unsafe paths and Python/JavaScript canonical-string handling |
| Backend focused regression run | 20 tests passed: 6 surface integrity, 10 capture recovery, 4 optional-counterparty | Surface commands and existing core capture/finalization compatibility |
| Backend surface suite after hardening | Latest 6 tests passed | Current request/source binding, crash/lease behavior, authorization, immutable evidence and rejection of qualified worker findings |
| Actual API → Python → export integration | Passed with generated PNG protocol fixtures and the real subprocess | Uploads, extraction/comparison, exact original downloads, persisted private artifacts and offline verification operate together |
| Mobile targeted checks | 27 tests passed; TypeScript check passed | Research journal, binding, recovery and related client contracts; not physical-device acceptance |
| Web targeted checks | 13 tests passed; typecheck and R&D build passed | Opt-in review, scopes, source binding, retry behavior and client compilation |
| Desktop targeted checks | 25 tests passed; typecheck and R&D build passed | Research login/IPC/review behavior and desktop code compilation |
| Build isolation / local launcher | 4 isolation tests and 2 launcher tests passed | Separate identities, rejection of live configuration and isolated local environment construction |
| Existing release configuration checks | 20 mobile and 15 desktop tests passed | Compatibility with the established release-configuration boundaries |
| Fresh local sandbox over HTTP | Login returned 200; Proof creation 201; capture-session creation 201, with research enabled and the actual Python interpreter configured | The isolated launcher starts a usable local API; no physical recording was performed by this check |
| Hosted research-checks job | Succeeded in workflow run `36900668255` | The hosted Linux workflow reran its worker/verifier/backend research checks successfully |

The real integration test preserved the finalized root's exact canonical bytes and SHA-256 before and after later surface media, records and analyses. The offline verifier checked **3 records, 3 analyses and 2 HTTP-downloaded original files** against pinned root/head values and returned `INTEGRITY_CHECKED`. Supplying retained private worker artifacts separately verified template/result commitments across the Python → Node → JSONB path. Deliberately tampered source bytes were rejected. All physical outcomes stayed unqualified/inconclusive.

The generated fixtures exercised a mobile-shaped context/barcode input and candidate carton-region discovery. This confirms the contract between components; it does not demonstrate real label/carton discrimination or reliable field-of-view association.

## Build artifact ledger

Initial hosted run: `36900668255`, application source `3637c5038b564fe432d8f218ed731a837301b2c6`. Android-only retry: `36901301069`, workflow-fix commit `1f72154fe6a69b4f78565892a385a1aadc1d1254`.

Installer hashes below describe the delivered files, not their enclosing Actions ZIPs. macOS PKGs were copied unchanged from the initial build into smaller archives in run `36901626891` (workflow commit `6526cc46dab7288cb2c2c1eb12418f856937bce5`); their original source and byte commitments were checked before and after download. The application was not rebuilt for that transfer.

| Deliverable | Status at this report snapshot | Final file / artifact ID | SHA-256 |
| --- | --- | --- | --- |
| Windows x64 research installer | Build succeeded; downloaded original EXE verified | `PackProof-RND-Windows-x64.exe`; artifact `11182155028` | `b82ce523184b38fd96b17bf144cc9225d7f8d22a0d128e968741625b04667602` |
| macOS Intel research installer | Build succeeded; original PKG verified | `PackProof-RND-macOS-Intel.pkg`; artifact `11182370651` | `f08f73641edc696979691d6d6d5a04821fb9ed6c04d7ff7e5efc92d9b208f1b3` |
| macOS Apple Silicon research installer | Build succeeded; original PKG verified | `PackProof-RND-macOS-Apple-Silicon.pkg`; artifact `11182240738` | `e750b6690a15bb7bd7ab86efc67ced73165bc9cac070124125f183190b7e022f` |
| Android ARM64 standalone research APK | Corrected build succeeded; actual package/bundle/signature checked and downloaded bytes verified | `PackProof-RND-Android.apk`; artifact `11182011996` | `28713053044f23b58226563d871c5b905317904c43319a50a9b5e186e06d3f34` |
| iOS Simulator research application ZIP | Initial native build failed; diagnostic rerun `36903416758` is compiling at workflow-only commit `44ba541b43fd5db28592a274f2de817b33974595` | Pending successful completion and artifact verification | Pending |
| Standalone web research ZIP | Compiled locally from application source above | `PackProof-RND-Web.zip` | `a354d9cf65924059a281f03cd8e904f2c1f0d7fd4218c1bba35dc6ac085fd2e7` |

Research Android uses package `com.packproof.mobile.rnd` and a generated test signing key. iOS uses the same separate bundle identifier and produces a **Simulator application**, not an installable iPhone IPA. Desktop uses `com.thepackproof.desktop.research` and “PackProof RND”; Windows is unsigned and macOS uses ad-hoc application signing without notarization. Native build success does not mean the installers have been manually exercised or the cameras qualified.

## Start the local research environment

The tested worker dependency lock is specifically **Linux x86_64, CPython 3.12**, with NumPy 2.2.6 and `opencv-python-headless` 4.11.0.86. Use Node.js 24, Python 3.12 with virtual-environment support, and installed `ffmpeg`/`ffprobe` for the backend's existing video-media validation. The source repository is needed for the API and worker; the desktop installer is a client.

For a Windows desktop, run the API/worker in an x86_64 Linux environment under WSL2. Keep the source and virtual environment inside that Linux filesystem. From the repository root in the Linux shell:

```sh
npm --prefix backend ci
npm --prefix mobile ci
npm --prefix web ci
python3.12 -m venv surface-worker/.venv
surface-worker/.venv/bin/python -m pip install --require-hashes --only-binary=:all: -r surface-worker/requirements.lock
node scripts/rnd/dev.mjs --enable-research --python "$PWD/surface-worker/.venv/bin/python"
```

The runner starts the web UI at `http://127.0.0.1:5173` and API at `http://127.0.0.1:3000`, with local data under `data/rnd/`. It explicitly selects local storage, a separate database, development identities and unsigned research manifests. Customer findings remain disabled even with `--enable-research`. Omit that option to exercise feature-off behavior; use `--api-only` when the desktop or mobile client is the only UI needed. Stop the runner with Ctrl+C.

Before opening the Windows desktop client, confirm that Windows can reach the WSL2 service. For example, in Windows PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
```

If that check fails, resolve Windows↔WSL localhost forwarding before testing the client. The R&D app intentionally will not switch to the live PackProof API. In the research client, use a local research identity such as `surface-researcher`; the same identity connects the same local workspace across clients. Production email/password credentials are not part of this flow.

The macOS desktop packages are native clients, but **a native macOS Python-worker lock has not been validated**. To use one with this tested worker, run the isolated service on a Linux x86_64 host and provide an authenticated loopback tunnel on the Mac. For an already authorized research host, the connection shape is:

```sh
ssh -N -L 127.0.0.1:3000:127.0.0.1:3000 user@research-host
```

The default desktop/iOS Simulator client then uses its local port 3000. The tunnel is not created by the installer, and no remote host or tunnel was deployed during this work. Keep the development API bound to loopback; do not expose development login to a public network.

## Connect the Android research build

Keep the local API running and verify the Windows host can reach port 3000. Enable USB debugging on the intended S24 Ultra or A16, connect it, approve the computer on the phone, and use Android platform-tools on Windows:

```sh
adb devices
adb -s DEVICE_SERIAL reverse tcp:3000 tcp:3000
adb -s DEVICE_SERIAL install -r PATH_TO_PackProof-RND-Android.apk
```

Replace the serial and APK path with the actual values. Repeat the reverse mapping for each phone; two attached phones require explicit serial selection. Open **PackProof RND**, sign in with a local research identity, opt into the research capture/review controls, and create an ordinary outbound Proof with its expected shipping identifier. Use the existing continuous capture flow. Sampling may legitimately produce unavailable/inconclusive results.

Review the committed source references and coverage in the same local Proof on web/desktop. A later authorized “Compare package” capture must use the expected enrollment. Device time, stage statements and app/request assurance remain explicit metadata; they do not certify when or what the camera saw. The connection procedure has not itself been exercised on physical phones in this task.

An iOS Simulator artifact, if compilation succeeds, supports installation in Simulator on a Mac with Xcode. It cannot run on an iPhone and cannot validate optics. A separately provisioned research device build and independent physical iPhone testing remain necessary.

## Measurements and remaining gates

The recorded synthetic microbenchmark ran the same fixture five times on the shared Linux execution host: median wall time approximately **0.649 seconds**, nearest-rank p95 approximately **0.919 seconds**, peak process RSS approximately **90.1 MiB**, and total input image bytes **1,337,776**. Result digests were identical. These are software observations from repeated generated inputs, not independent trials, a representative workload p95, mobile incremental memory, cloud unit cost or a production performance claim. Exact samples/runtime digests are in `surface-worker/reports/SYNTHETIC_BENCHMARK.json`.

The real corpus contains **0 labels, 0 cartons, 0 device captures and 0 physical trials**. The 240-label/60-carton screening target, 1,000-assembly engineering expansion and statistical false-consistency gate remain future experiments. The empty `qualified-profiles.json` is intentional.

Before qualified findings or a pilot, the following work remains:

1. Run actual S24 Ultra↔A16 capture in both directions, then independent Android and iPhone devices. Measure uninterrupted recording, optical detail, passive success, lifecycle/recovery, storage, thermal and memory behavior.
2. Collect same-content physical reprints across printer units/media lots and genuine-label transfer controls. Test whether the residual signal follows the material rather than graphics, printer identity or camera noise. Validate candidate carton/material regions.
3. Freeze supported profiles and thresholds before independent blind evaluation. Establish error/coverage denominators, uncertainty, shipping/aging/wear limits and screen/print/patch-transfer attack resistance. Synthetic repeats cannot establish these gates.
4. Complete device/app assurance integrations, production access/storage review and no-network decoder isolation. The tested bare subprocess has resource bounds but is not a production network/syscall sandbox; the container recipe still requires build, image pin/scan and runtime integration evidence.
5. Measure actual cloud/storage/request/transfer/retry costs, real workflow effort, reviewer comprehension and repeated merchant value. Rehearse rollback while preserving ordinary capture and old evidence. No physical corpus, cloud cost pass or production rollout is implied by this report.

Gate A remains closed: the software is available for controlled research, while reliable phone-native physical fingerprinting is still an untested scientific hypothesis for PackProof's actual workflow. See `PHYSICAL_PROTOCOL.md`, `SUPPORT_AND_GATES.md`, `EXPORT_VERIFICATION.md` and `IMPLEMENTATION_STATUS.md` for the exact scope and acceptance requirements.
