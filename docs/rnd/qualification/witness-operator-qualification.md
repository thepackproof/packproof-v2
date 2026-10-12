# F09-04: independent witness operator packet

Status: offline enrollment preparation complete; independent operators **0**;
external security review **pending**; qualification and release authorization **none**.
No operator was contacted, enrolled, deployed or made authoritative by this work.

## Prepared engineering

The [public packet checker](../../../research/qualification/witness/operator_profile.py)
checks the exact bytes of a proposed `packproof.witness-trust.v1` policy and a
[two-operator packet](witness-operator-packet.template.json). The template is deliberately
incomplete and must fail validation until actual reviewed facts are supplied.

The checker is offline and uses only Python's standard library. It bounds document
sizes/depth, rejects duplicate JSON keys, validates exact Ed25519
[RFC 8410 public-key containers](https://www.rfc-editor.org/rfc/rfc8410.html#section-4)
and SHA-256 fingerprints of the raw 32-byte public keys, and rejects
private-key containers, expired/revoked/test witness keys, duplicate operators and
declared organizations, log/witness key reuse, missing documentary hashes, and
credential-bearing or nonpublic endpoint syntax. Explicit UTC key validity windows
are required for this new enrollment packet; historical prototype trust policies
without them are not silently promoted to external readiness.

Names, public keys and document hashes cannot establish organizational independence,
private-key possession, service reachability or an agreement. Successful output
therefore always retains `verifiedIndependentOperatorCount: 0`,
`externalEvidenceAuthenticated: false`, `endpointReachabilityChecked: false`,
`qualificationPassed: false` and `releaseAuthorized: false`. HTTPS syntax checking
does not resolve DNS, connect to an endpoint or protect a future network adapter by
itself. No output from this tool is consumed as an activation policy by the backend.

```sh
python -m unittest discover -s research/qualification/witness -p 'test_*.py' -v
python research/qualification/witness/operator_profile.py --policy public-policy.json --packet completed-public-packet.json
```

## Packet to complete for each of the two operators

| Required fact/evidence | What the owner and operator must supply |
| --- | --- |
| Named organization and operator ID | Actual organization, responsible role and evidence that control is independent of PackProof and the other witness; different names alone are insufficient. |
| Public keys and possession | Ed25519 public PEM and SHA-256 raw-key fingerprint, exchanged over an authenticated separate channel. Retain the authenticated exchange/challenge evidence privately and put only its digest in the packet. Private keys remain with the operator. |
| Operational agreement | Scope, checkpoint freshness target, retention, incident role, access responsibilities, key rotation/revocation and conflict response. Retain the signed/approved agreement privately; record its digest. |
| Compatible service | A reviewed endpoint implementing the current `packproof-pymerkle-json-v1` checkpoint/signature/consistency semantics. A Tessera or signed-note endpoint needs a separately implemented and reviewed adapter; changing the label cannot make it compatible. |
| Durable state and restore | Operator-controlled durable last checkpoint and history, backup restoration exercise, rollback/split-view rejection and an independently retained checkpoint anchor. Record the exact exercise receipt digest. |
| Security review | Reviewer role and evidence covering organizational control, authentic key exchange, trust-policy distribution, signing/consistency semantics, failure/recovery behavior and operator service boundaries. The checker never approves that review. |

The proposed policy must be obtained and pinned through an authenticated channel
outside the proof bundle. Retain historical public keys and checkpoints for historical
verification. Publish an explicitly reviewed new policy/version for rotations; never
accept a receipt's suggested replacement key automatically. A conflicting checkpoint
must stop witnessing and trigger investigation; clearing the state to accept it is not
a recovery procedure. Both required signatures are mandatory.

The current Merkle implementation uses `pymerkle==6.1.0` and its JSON proof encoding.
The existing [witness implementation](../../../research/witness/README.md) has real
inclusion/consistency checks, durable local operator state, split-view rejection and
a SQLite restore rehearsal. The backend adapter only accepts centrally controlled
**test** operators (`testOnly: true`, `independent: false`). External operator
integration still requires implementing the chosen network transport, authenticated
service/key binding, bounded timeouts/retries, durable checkpoint exchange and a
consented two-operator exercise. This packet does not bypass that intentional boundary.

## External execution and acceptance sequence

1. The owner nominates two willing independent organizations and their technical roles,
   obtains agreement to the limited blinded-checkpoint scope, and supplies their public
   key material through authenticated exchange. No private keys belong in chat or this
   packet. Review operational and dependency/license obligations before distribution.
2. Review the exact public policy and protocol/profile. Complete the public packet and
   run its offline checks. Have the reviewer authenticate the referenced private evidence.
3. Implement the chosen service adapters in isolation, then exercise both actual operators:
   inclusion; real extension consistency; repeated submission; offline witness;
   stale checkpoint; conflict; rollback; key expiry/revocation; and restart/restore.
   Preserve failed/aborted outcomes as well as successful receipts.
4. Verify both signatures under the independently pinned policy and compare the restored
   history with the external checkpoint anchor. Record measured freshness/availability
   against the agreed targets; local test timings cannot establish a network SLO.
5. Record the security review and exact supported profile. External reliance and any
   service deployment/release remain separate owner decisions after those results.

What is needed now: **two named willing outside operator organizations and contacts,
authenticated public keys, agreed operating responsibilities, and a security reviewer**.
The unfinished network integration can then target real, reviewed contracts instead
of an invented endpoint. Witnesses attest checkpoint consistency for an included
commitment; they do not inspect media, certify a scene, prove omitted records absent,
or decide fraud, custody, fault or a claim outcome. Timing and log volume remain visible.
