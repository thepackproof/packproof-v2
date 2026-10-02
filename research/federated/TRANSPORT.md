# ProofCollective authenticated transport

`proofcollective.mtls` provides an actual TLS 1.3 adapter for the same serialized
Flower messages used by `SecAggPlusWorkflow` and `secaggplus_mod`. Python's `ssl`
module and its linked OpenSSL implement TLS. The adapter adds application framing,
explicit certificate enrollment and Flower message correlation; it does not replace
Flower's cryptography or implement an encryption algorithm.

Run the bounded local socket exercise:

```sh
PYTHONPATH=research/federated /tmp/packproof-federated-venv/bin/python -m proofcollective.cli simulate --clients 20 --rounds 1 --transport local-mtls --output /tmp/proofcollective-mtls-new
PYTHONPATH=research/federated /tmp/packproof-federated-venv/bin/python -m pytest research/federated/tests/test_mtls.py -q
```

Each synthetic partner has a separate server thread and temporary certificate. The
coordinator opens a real loopback TLS connection for every protocol message. A
synthetic certificate authority exists only for the run; its private key is never
written. Temporary private leaf keys use mode 0600 in a mode 0700 directory and are
removed on shutdown. No generated TLS keys are copied into reports. This is one
process under one operator, with **zero independent organizations**. It validates
transport behavior, not isolation from that operator or qualification of a pilot.
The default `--transport simulated` remains the earlier Fernet in-process exercise.

## Enforced protocol

- Both sides require a certificate chain rooted in the explicitly configured CA.
  OpenSSL enforces certificate validity and role/EKU. The coordinator also checks
  the configured partner hostname. System public CAs are not implicitly trusted.
- Both sides additionally compare the complete peer-certificate SHA256 against an
  exact enrolled pin and require exactly one matching node URI SAN:
  `urn:packproof:proofcollective:node:N`. Node0 is the coordinator; partner IDs are
  distinct positive integers. A CA-valid but unpinned certificate is rejected.
- TLS 1.3 and ALPN `packproof-flower-v1` are mandatory. The adapter disables session
  tickets and compression and does not opt into `SSLKEYLOGFILE`.
- Each connection carries one 4-byte network-order length followed by one Flower
  protobuf, with a 2 MiB limit and a 5-second total frame deadline. Handshakes and socket
  operations also have bounded timeouts. Unauthenticated frames never reach a
  training handler. There is no plaintext mode or authentication fallback.
- Requests bind run ID, source coordinator, destination partner, message ID, type,
  and bounded creation time/TTL. Replies must bind that exact request and group.
  Replay sets are bounded; endpoints reject duplicate IDs and session exhaustion.
  Operational partner profiles also require a private persistent admission ledger:
  starting an endpoint durably consumes a strictly increasing run ID. Restarting with
  that ID or an older ID is refused, so restarting cannot reset replay admission.
  Profile expiry is enforced before each exchange and again before returning results.
- Server telemetry consists only of accepted/rejected/handshake counts. It never
  logs protobufs, local examples, labels, updates, exception text or peer addresses.
  The aggregate report contains counts and stage outcomes, not transport secrets.

The actual tests use real sockets and certificates. They corrupt an encrypted TLS
record after a completed handshake through a TCP proxy, reject wrong CA/pin/hostname
and missing client certificates, reject cross-party/cross-run messages, bound frames,
reject replay, observe consent withdrawal through a fresh read-only ledger connection,
and recover the expected aggregate from 22 clients with 2 dropouts. The twenty remaining
contributors satisfy the existing floor. No raw update is captured in test output.

## Operational profile

`load_transport_profile(path)` validates `proofcollective-mtls-profile/v1` JSON before
creating a client or listener. See `transport-profile.example.json`: it is deliberately
incomplete and fails closed until real independently approved enrollments, pins, paths,
endpoints and a current expiry are supplied. The loader requires 20–64 distinct
participants and certificate pins, the local certificate to match its enrolled node,
the exact training purpose, an expiry within 90 days, and production authorization
false. A profile cannot grant training consent or release permission.

For an approved deployment, issue separate partner-owned private keys and certificates
with server-auth EKU, hostname SAN and the exact node URI. Issue a coordinator-owned
client-auth certificate with node 0 URI. Use a dedicated reviewed research CA; pin every
leaf certificate by an independently checked fingerprint. Restrict each partner's
listener/firewall to its intended coordinator, use explicit private-network addresses,
and distribute only that party's private key. Never distribute the synthetic lab CA
or place all partner private keys on the coordinator. Restart a session with a new run
ID and freshly approved roster on every endpoint restart, enrollment, revocation or
certificate rotation; never silently accept a new certificate. Keep the roster/expiry authority protected
and check that revocation has reached every party before another round.

`admissionLedger` must point to that partner's durable SQLite file in a private
directory. Session admission is atomic and append-only, and even a startup failure
may consume an ID. Coordinate a fresh increasing run ID across all parties before
retrying; do not delete the ledger to reset a run. Losing or restoring stale admission
state requires separate operator recovery review. The lab filesystem owner can erase
a SQLite file, so governed storage, backup and rollback protection remain deployment
requirements. The ephemeral local CLI has no durable enrollment authority and makes
no restart-persistence claim.

The API provides the operational construction points:

```python
from pathlib import Path
from proofcollective.mtls import load_transport_profile

profile = load_transport_profile(Path('/private/research/transport.json'))
# Coordinator profile (localNodeId == 0):
client = profile.client()
# client.exchange(partner_node_id, flower_message)

# Partner profile (localNodeId > 0), in the partner-controlled process:
# server = profile.server(authenticated_local_flower_handler)
# Keep server alive for the approved session; always call server.close() on exit.
```

`authenticated_local_flower_handler` must retain the participant's Flower Context,
call the unmodified `secaggplus_mod`, verify the approved model/recipe and exact local
dataset consent, enforce local training bounds and recheck withdrawal. The tested
`LocalSimulationGrid._respond` illustrates that handler. In the local mTLS CLI, fresh
read-only SQLite connections allow consent checks from endpoint threads; a real
operator requires its own governed consent authority. The transport never conveys
raw local datasets. No remote-deployment command or pilot authorization is supplied.

Deployment still requires independent security/privacy review, protected enrollment
and accounting, certificate lifecycle and compromise exercises, separate operators,
actual partner consent and useful representative task evaluation. The coordinator
still sees the pre-noise aggregate. TLS does not add distributed-noise privacy or prove
honest clients, clipping, camera provenance, model utility, or organizational diversity.

## Measured local result

`reports/2026-10-02-mtls/` records one 20-client, one-round signed-recipe training run:
80 TLS connections, all four real Flower stages, 6.416 seconds, epsilon 1.14317 at
delta 1e-6. The noisy synthetic accuracy was 74.77%, versus 84.96% frozen baseline.
The utility gate **failed**, so that candidate was not promoted. It is preserved
without favorable-run selection; its result validates transport execution only.

Primary implementation reference:
[Python 3.12 ssl/OpenSSL documentation](https://docs.python.org/3.12/library/ssl.html).
The runtime's actual OpenSSL version is recorded in the transport validation report.
