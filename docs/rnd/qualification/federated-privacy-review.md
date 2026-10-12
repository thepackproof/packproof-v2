# F10-05: stronger privacy research packet

Status: analytical preparation executed; distributed-noise mode remains disabled.
This packet requests a reviewed mechanism, not approval of a purported privacy guarantee.
The current central-noise implementation and existing candidate gates are unchanged.

## Completed independently

The offline planner in `research/qualification/federated/noise_envelope.py` enumerates
survivor/colluder assumptions, identifies insufficient hidden noise under naive cohort
calibration, and computes the ideal continuous-Gaussian variance requirement for each
case. It neither samples noise nor trains a model, writes a candidate, contacts peers,
changes consent, or enables a privacy mode. Every report states `qualified: false` and
contains no epsilon claim.

The example assumptions are hypothetical: 24 enrolled contributors, at least 20
survivors, at most four colluding survivors, L2 bound 1 and target multiplier 4.
These values are a review example, not accepted participant or threat assumptions.
All 25 combinations were evaluated. In the worst allowed case there are 16 hypothesized
honest survivors. Replacement sensitivity of the sum is 2; its required hidden noise
standard deviation is 8. Independent honest shares would therefore need standard
deviation 2 in this ideal model. Dividing by 20 survivors yields mean noise standard
deviation 0.4. Calibrating shares to all 24 original participants instead leaves an
effective multiplier of about 3.266, below the intended 4 after dropout/colluder noise
is removed. This is a counterexample to naive calibration, not a privacy certification.

A diagnostic executed the installed Flower 1.39.0 quantizer on public values
`[-4, -1, 0, 1, 4]`. With the current clipping range, reconstruction was
`[-1, -1, 0, 1, 1]`. Appending unbounded Gaussian noise to the current participant
update would therefore change the intended mechanism at clipping. The existing
aggregate sanity check also expects bounded unnoised updates. A reviewed discrete
encoder, noise mechanism, range analysis, accountant and acceptance policy are needed
before connecting a stronger mechanism to this transport.

## Reproduce

From the repository root, using the existing isolated federated Python environment:

```sh
python -m unittest discover -s research/qualification/federated -p 'test_*.py' -v
python research/qualification/federated/noise_envelope.py --config research/qualification/federated/example-assumptions.json --output /private/new-noise-envelope.json --probe-installed-flower
```

Without `--probe-installed-flower`, the planner uses only Python's standard library.
The optional probe needs the existing pinned Flower environment. The output path must
be new; earlier reports are never overwritten. Config/tool hashes and, for the probe,
the installed version and quantizer source hash bind the observation to actual bytes.

## Concrete review scope

The reviewer receives the current `research/federated/` source and dependency lock,
`model-policy.json`, this analysis and the source-specific 54-test execution receipt
in `docs/rnd/validation/2026-10-11-follow-up.json`. Request a written decision covering:

1. Protected unit and adjacency: one enrolled organization's clipped contribution,
   replacement sensitivity, fixed membership and how identities resist duplicate control.
2. Maximum colluding participants/coordinator behavior, minimum independently honest
   survivors, adaptive dropout, repeated cohort selection and disclosure through aborts.
3. A specified discrete-noise family and sampler, entropy custody, proof that noise is
   retained through survivor changes, quantization bias/tails and modular wraparound.
4. Malicious-client clipping/noise compliance, protocol and key-reconstruction thresholds,
   transcript leakage, and what the coordinator can see at each stage.
5. Composition across retries, failures and rounds; population/delta rules; finite-precision
   analysis; accountant compatibility and a reviewable test vector suite.
6. The governed final consent/withdrawal boundary and permissible storage after acknowledgement.
7. Measured utility and costs on separately held-out, consented partner data before any pilot.

The planner cannot verify these assumptions. It deliberately does not convert variance
into epsilon, declare distributed DP enabled, or reuse the central accountant as a proof
for a different mechanism. Source-reviewed constraints must be implemented and tested
after mechanism selection; an external review alone will not finish that future code.

## Needed from the owner

- Nominate an independent reviewer with distributed differential privacy and secure
  aggregation expertise, or provide a budget/contact through which to arrange that work.
  No external message has been sent by this task.
- Have that reviewer and the participating organizations define the tolerated collusion,
  dropout and governance assumptions; the example numbers above are not owner approvals.
- For later independent execution, identify at least 20 separately enrolled consenting
  contributor organizations per released pilot aggregate, with their own machines,
  keys and permitted local datasets. Twenty processes on the S24/PC do not supply them.
- Provide the reviewed mechanism and signed-off technical findings. I can then implement
  its approved experimental integration and run the defined failure cases. Pilot/release
  authorization remains a separate decision.

## Primary sources consulted

The [distributed discrete Gaussian paper](https://proceedings.mlr.press/v139/kairouz21a.html)
analyzes client-side discrete noise together with quantization and modular aggregation.
Its analysis motivates treating the whole encoder and noise pipeline as a mechanism;
the planner above does not reproduce that proof. The authors' [reference implementation](https://github.com/google-research/federated/blob/master/distributed_dp/README.md)
separates accounting, encoding, discrete sampling and modular clipping. These are
design references, not validation of PackProof's transport or threat assumptions.
Flower's [SecAgg+ API](https://flower.ai/docs/framework/ref-api/flwr.client.mod.secaggplus_mod.html)
documents the integration used here; the clipping finding comes from executing the
installed pinned source, not from assuming behavior from current online documentation.
