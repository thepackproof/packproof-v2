import base64
import copy
from datetime import datetime, timezone
import hashlib
import json
import unittest

from operator_profile import decode_document, validate

AT = datetime(2026, 10, 12, tzinfo=timezone.utc)


def fixtures():
    # Synthetic public container bytes. No private keys or real operator identities.
    def entry(number, operator, independent):
        raw = bytes([number]) * 32
        kid = hashlib.sha256(raw).hexdigest()
        pem = '-----BEGIN PUBLIC KEY-----\n' + base64.b64encode(bytes.fromhex('302a300506032b6570032100') + raw).decode() + '\n-----END PUBLIC KEY-----\n'
        return kid, {'keyId': kid, 'publicKeyPem': pem, 'operatorId': operator,
                     'testOnly': False, 'independent': independent, 'revoked': False,
                     'validFrom': '2026-01-01T00:00:00Z', 'validUntil': '2027-01-01T00:00:00Z'}
    log, first, second = entry(1, 'log', False), entry(2, 'one', True), entry(3, 'two', True)
    policy = {'schemaVersion': 'packproof.witness-trust.v1', 'policyId': 'synthetic-policy',
              'logId': 'synthetic-log', 'testOnly': False, 'requiredOperators': ['one', 'two'],
              'logKeys': dict([log]), 'witnessKeys': dict([first, second])}
    operators = []
    for kid, key in (first, second):
        operators.append({'operatorId': key['operatorId'], 'organizationId': 'synthetic-' + key['operatorId'],
                          'publicKeyIds': [kid], 'serviceEndpoint': 'https://' + key['operatorId'] + '.example.org/witness',
                          'protocol': 'packproof-pymerkle-json-v1', 'checkpointMaxAgeSeconds': 300,
                          'retentionDays': 365, 'incidentContactRole': 'witness incident team',
                          'keyExchangeEvidenceSha256': 'a' * 64, 'agreementEvidenceSha256': 'b' * 64,
                          'restoreExerciseEvidenceSha256': 'c' * 64})
    packet = {'schemaVersion': 'packproof.witness-operator-packet.v1', 'policySha256': '',
              'logOrganizationId': 'synthetic-log-owner', 'operators': operators,
              'independenceReview': {'reviewerRole': 'synthetic reviewer', 'evidenceSha256': 'd' * 64}}
    return policy, packet


def bind(policy, packet):
    raw = json.dumps(policy, sort_keys=True).encode()
    packet['policySha256'] = hashlib.sha256(raw).hexdigest()
    return raw


class OperatorPacketTests(unittest.TestCase):
    def setUp(self):
        self.policy, self.packet = fixtures()

    def assess(self):
        return validate(self.policy, self.packet, bind(self.policy, self.packet), at=AT)

    def test_structural_success_never_qualifies_or_authenticates_external_evidence(self):
        result = self.assess()
        self.assertTrue(result['publicPacketValid'])
        self.assertEqual(result['declaredOperatorCount'], 2)
        self.assertEqual(result['verifiedIndependentOperatorCount'], 0)
        for flag in ('externalEvidenceAuthenticated', 'endpointReachabilityChecked', 'qualificationPassed', 'releaseAuthorized'):
            self.assertIs(result[flag], False)

    def test_exact_policy_bytes_and_parsed_object_must_both_match(self):
        raw = bind(self.policy, self.packet)
        with self.assertRaisesRegex(ValueError, 'EXACT_POLICY_BYTES'):
            validate(self.policy, self.packet, raw + b'\n', at=AT)
        changed = copy.deepcopy(self.policy)
        changed['policyId'] = 'substitution'
        with self.assertRaisesRegex(ValueError, 'PARSED_POLICY_BYTES'):
            validate(changed, self.packet, raw, at=AT)

    def test_fingerprint_substitution_rejected(self):
        entries = list(self.policy['witnessKeys'].values())
        entries[0]['publicKeyPem'] = entries[1]['publicKeyPem']
        with self.assertRaisesRegex(ValueError, 'PUBLIC_KEY_ID_MISMATCH'):
            self.assess()

    def test_private_key_and_non_ed25519_containers_rejected(self):
        entry = next(iter(self.policy['witnessKeys'].values()))
        for pem in ('-----BEGIN PRIVATE KEY-----\nREDACTED\n-----END PRIVATE KEY-----',
                    '-----BEGIN PUBLIC KEY-----\n' + base64.b64encode(b'X' * 44).decode() + '\n-----END PUBLIC KEY-----'):
            with self.subTest(pem_type=pem[:27]):
                entry['publicKeyPem'] = pem
                with self.assertRaises(ValueError):
                    self.assess()

    def test_revoked_expired_not_yet_valid_and_nonindependent_witness_rejected(self):
        for field, value in [('revoked', True), ('validUntil', '2026-02-01T00:00:00Z'),
                             ('validFrom', '2026-12-01T00:00:00Z'), ('independent', False), ('testOnly', True)]:
            with self.subTest(field=field):
                self.policy, self.packet = fixtures()
                next(iter(self.policy['witnessKeys'].values()))[field] = value
                with self.assertRaisesRegex(ValueError, 'CURRENT_ENROLLED_WITNESS_KEY'):
                    self.assess()

    def test_test_policy_and_truthy_numeric_flags_rejected(self):
        self.policy['testOnly'] = True
        with self.assertRaises(ValueError): self.assess()
        self.policy['testOnly'] = False
        next(iter(self.policy['witnessKeys'].values()))['independent'] = 1
        with self.assertRaisesRegex(ValueError, 'BOOLEAN_KEY_FLAGS'): self.assess()

    def test_duplicate_operator_and_declared_organization_rejected(self):
        for field in ('operatorId', 'organizationId'):
            with self.subTest(field=field):
                self.policy, self.packet = fixtures()
                self.packet['operators'][1][field] = self.packet['operators'][0][field]
                with self.assertRaises(ValueError): self.assess()
        self.policy, self.packet = fixtures()
        self.packet['independenceReview']['reviewerRole'] = ''
        with self.assertRaisesRegex(ValueError, 'REVIEWER_ROLE_REQUIRED'): self.assess()

    def test_log_witness_key_reuse_rejected(self):
        kid, entry = next(iter(self.policy['logKeys'].items()))
        self.policy['witnessKeys'][kid] = entry
        with self.assertRaisesRegex(ValueError, 'LOG_WITNESS_KEY_REUSE'): self.assess()

    def test_secret_bearing_and_nonpublic_endpoint_syntax_rejected(self):
        for endpoint in ('http://one.example.org', 'https://user:secret@one.example.org',
                         'https://one.example.org?token=not-a-real-token', 'https://127.0.0.1',
                         'https://10.0.0.1', 'https://localhost', 'https://one..example.org',
                         'https://one.example.org:8443', 'https://one.example.org#secret'):
            with self.subTest(endpoint=endpoint):
                self.packet['operators'][0]['serviceEndpoint'] = endpoint
                with self.assertRaisesRegex(ValueError, 'PUBLIC_HTTPS_ENDPOINT'): self.assess()

    def test_unreviewed_protocol_unbounded_targets_and_absent_evidence_rejected(self):
        for field, value in [('protocol', 'tessera'), ('checkpointMaxAgeSeconds', True),
                             ('retentionDays', 0), ('agreementEvidenceSha256', None)]:
            with self.subTest(field=field):
                self.policy, self.packet = fixtures()
                self.packet['operators'][0][field] = value
                with self.assertRaises(ValueError): self.assess()

    def test_key_window_order_and_missing_fields_rejected(self):
        key = next(iter(self.policy['witnessKeys'].values()))
        key['validUntil'] = key['validFrom']
        with self.assertRaisesRegex(ValueError, 'KEY_INTERVAL_ORDER'): self.assess()
        del key['validUntil']
        with self.assertRaisesRegex(ValueError, 'PUBLIC_KEY_ENTRY_FIELDS'): self.assess()

    def test_bounded_duplicate_safe_document_reader(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b' ' * 65537, b'', b'[' * 2000 + b']' * 2000, b'\xff'):
            with self.subTest(size=len(raw)):
                with self.assertRaises(ValueError): decode_document(raw)


if __name__ == '__main__': unittest.main()
