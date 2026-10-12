# Physical-study intake packet

This packet prepares F01-02 optical screening, F01-06 security qualification, F04-06 metrology, F06-05 replay, F08-03 control-policy qualification and F08-06 paired comparison. It supplies offline preparation and intake checks. No physical result is supplied by this packet, its test fixtures or its generated allocation list. All six qualification items remain dependent on actual measurements and independent review.

The user currently has a Galaxy S24 Ultra and a desktop PC. Phone connection is deferred until the user is ready. iOS work remains deferred. The first useful step is a read-only phone inventory; the next is a small ordinary-recording pilot after the exact research build and recording protocol are reviewed. Neither requires the full 240-label population.

## Stage 0A — phone and PC only

When the owner connects and authorizes the S24 Ultra over USB, run the saved read-only inventory from the repository root with Python 3.12 or later and the actual local Android platform-tools path:

```powershell
python research/qualification/physical/device_preflight.py --adb "C:/path/to/platform-tools/adb.exe" --output "C:/PackProofPrivate/s24-passive-inventory.json"
```

With more than one authorized phone connected, specify `--serial` explicitly. The serial is used locally and omitted from the output. The tool reads model, Android/SDK/build/security patch, available camera metadata, battery and platform thermal status. It neither opens a camera nor installs an app, changes settings, captures media or runs a stress test. It marks unavailable OEM metadata as unavailable; battery temperature is not camera, processor or skin temperature. A thermal status of zero is not a qualified safety envelope.

**User action needed now:** none until ready to connect the phone. Then provide the USB connection and approve the phone's ordinary USB debugging authorization. No further polling is needed before that. An actual app hash and native stream profile still need to be recorded before an acquisition protocol can freeze. The public Play app must not be presumed to include isolated R&D features. No installation is part of this packet.

## Stage 0B — one carton and one non-sensitive printed label

Supply one ordinary carton, one printed dummy label containing no real name/address/order, ordinary packing material/tape, and permission to record the packing surface. A stable normal room light and clear workspace are sufficient for this pilot. A ruler may describe approximate dimensions; it is not calibrated metrology. A second matching print and second carton are optional later additions for a small same-content/transfer rehearsal. There is no population, independence or rare-error claim from this pilot.

Before recording, fill the prepared protocol with pseudonymous operator/device/carton IDs, exact app hash/OS/stream profile, local consent and protocol-review references, retention deadline and three planned baseline attempts. Keep private consent documents and originals outside Git. The three attempts are a practical intake rehearsal, not a statistically powered sample size. Agree on the ordinary capture duration and interruption/abort procedure in the review document before recording; do not improvise thermal or battery stress testing.

All three initial attempts use `OFF`, ordinary continuous recording and `pilot` split. Retain the unedited original for each attempt. Record failures and exclusions even when no usable file exists. Do not splice a failed clip into a successful one. Extracted frames and previews remain derivatives of their original session and never count as additional independent acquisitions. Review decoding/continuity separately; the intake tool hashes files but does not decode them.

No research torch pattern, flashing display, automatic focus or automatic exposure adjustment is enabled. Stop on the phone's warning or an ordinary operator stop request and retain that attempt as an interruption/failure. The existing passive lease is not an active-control driver or a hardware safety qualification.

## Expansion needed for the six items

| Item | Useful preparation now | Actual additional material, access and evidence needed |
|---|---|---|
| F01-02 optical benchmark | Frozen allocation reference, original-byte bindings, specimen/split admission checks | 240 physically distinct labels: direct thermal, thermal transfer, inkjet and laser; three media lots per technology; two identical-content designs per lot; ten copies per design. 60 cartons: 20 each single-wall kraft, recycled corrugated and coated white corrugated, with ten new and ten reused per class. Access to the planned printer-unit runs through an authorized lab or print service; do not buy 24 printers merely because the plan has 24 distinct unit slots. Actual printer identities must support the frozen partition or the design must be reviewed/versioned before collection. |
| F01-06 security qualification | Attack-family plan and held-out identifier checks; existing exact-binomial evaluator retained | Actual same-content reprints, photographed prints, screen replays, label/carton-patch transfers, wrong templates, probing, malicious baselines, occlusion/reopening cases; independent ground-truth reviewer and separately frozen evaluation population. S24 Ultra/A16 directions plus an additional Android profile; independent iPhone work remains deferred. The 240-label screen cannot establish the 0.01% rare-error target; independence and sample design require review, with about 29,956 zero-error independent units for a one-sided 95% bound. |
| F04-06 metrology | Millimetre/unit checks, hash-bound calibration reference, explicit error/uncertainty calculation | An independent metrology operator/lab; calibrated scale/length references and their uncertainty records; unchanged controls and prespecified visible changes; measured physical ground truth, viewpoints and repeated measurements across carton sizes/materials, reflective tape, missing faces and natural shipping wear. A reconstructed mesh or ordinary ruler is not the ground truth. |
| F06-05 replay lab | Passive-only intake and named attack-family ledger | Dedicated, authorized genuine/display/print/laminated/delayed/adaptive replay specimens, reflections/material variation, held-out attack devices and reviewed injection harness. Obtain the device/exposure safety review before any active optical challenge. PC static images may rehearse labeling, but do not qualify replay resistance. No injection or active-light experiment is executed by these tools. |
| F08-03 control policy | Read-only profile and ordinary recorder baseline packet | First measure recorder continuity, recovery and overhead on the exact Android profile. A specialist must then specify/review device/OS-specific adjustment limits, restoration/continuity tests and stop rules. No qualified automatic focus/exposure profile or adjustment driver exists. Active-control implementation and its physical verification remain conditional; this packet deliberately rejects those controls. |
| F08-06 paired comparison | Balanced reproducible order generator; matched-pair admission, missing-arm retention, descriptive deltas | An actually functioning passive feature-on build/profile and ordinary feature-off baseline, matched real packing tasks, condition/cooldown protocol, consented operators, independent blinded readability/context reviewers, and reliable duration/frame-gap/dropped-frame/memory/thermal/battery measurements. Define metric sources and detail denominator before collection. One S24 pilot cannot qualify other devices or population benefit. |

Shared work can reuse authorized cartons, labeling tools, recording space and operators where the study design permits. Keep a specimen's identity, transferred-label identity, assembly state and derivatives together. Do not silently reuse a unit across frozen training/test partitions. Ordinary/coached capture strata remain separate. Heat, chemical, moisture and damaging attacks belong in a separately approved materials protocol, not the immediate pilot.

The prepared matrix has **12 media-lot slots and 24 printer-unit slots**. These are planned allocations, not proof that any equipment was supplied or any label was printed. Cross-device, print-design and operator holdouts need their own actual inventories. The existing broad benchmark holdout policy may reject same-device screening records; the intake reports that conflict and does not relax the evaluator.

## What the tooling completes

`research/qualification/physical/intake.py` derives an allocation reference from the existing frozen corpus file, binds both existing policy/template hashes, creates an intentionally incomplete Stage 0 protocol, freezes completed local protocol bytes before declared acquisition times, verifies explicitly named local artifacts, retains every planned attempt in denominators and reports pairing/metrology/holdout problems. It has no network or device operation.

`device_preflight.py` is separately opt-in and performs only the named Android reads above. Its mocked tests are software validation, not a recorded S24 profile.

The validators never set qualification or release eligibility true. A local hash, operator assertion or timestamp does not authenticate legal consent, calibration traceability, independent review or prior non-access to a test set. Preserve the frozen protocol and review evidence with the appropriate independent reviewer. Follow the actual consent and retention policy; the tool rejects processing after the declared retention deadline, but does not delete media for you.

See [physical-intake-format.md](physical-intake-format.md) for commands, exact fields and reports. Existing scientific thresholds and the evaluator remain in `research/benchmarks/`; this packet does not replace them.
