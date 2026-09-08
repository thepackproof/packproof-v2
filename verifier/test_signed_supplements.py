"""Portable signed-chain checks with synthetic authority/record keys and no network."""
import copy
import json
import subprocess
import unittest
import zipfile
import test_trust_registry as registry_fixture

verifier, NOW, STAMP = registry_fixture.verifier, registry_fixture.NOW, registry_fixture.STAMP

canon = lambda value: json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()


class SignedSupplementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        registry_fixture.SignedRegistryTests.setUpClass.__func__(cls)
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
                        '-out', str(cls.folder / 'supplement.key')], check=True, capture_output=True)
        subprocess.run(['openssl', 'pkey', '-in', str(cls.folder / 'supplement.key'), '-pubout',
                        '-out', str(cls.folder / 'supplement.pem')], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        registry_fixture.SignedRegistryTests.tearDownClass.__func__(cls)

    sign = registry_fixture.SignedRegistryTests.sign
    write_registry = registry_fixture.SignedRegistryTests.write_registry

    def setUp(self):
        registry_fixture.SignedRegistryTests.setUp(self)
        self.registry['keys'].append({**copy.deepcopy(self.registry['keys'][0]), 'keyId': 'supplement-key',
                                      'publicKeyPem': (self.folder / 'supplement.pem').read_text()})
        legacy = registry_fixture.SignedRegistryTests.archive(self)
        with zipfile.ZipFile(legacy) as archive:
            self.files = {name: archive.read(name) for name in archive.namelist() if name != 'integrity/hashes.json'}
        self.package = json.loads(self.files['package.json'])
        self.core = self.package['manifestSha256']
        self.rows = []
        previous = self.core
        for sequence in range(1, 4):
            facts = {'version': 1, 'domain': 'PACKPROOF_PROOF_SUPPLEMENT', 'supplementId': 'supplement_' + str(sequence),
                     'proofId': 'proof_fixture', 'sequence': sequence, 'operationId': 'operation:' + str(sequence),
                     'kind': 'CORRECTION', 'facts': {'note': 'Synthetic correction ' + str(sequence)},
                     'sourceReference': None, 'supersedesSupplementId': None, 'actorUserId': 'seller-fixture',
                     'attribution': 'PARTICIPANT_SUPPLIED', 'previousSha256': previous,
                     'coreManifestSha256': self.core, 'recordedAt': STAMP}
            raw = canon(facts)
            signature = self.sign(raw, 'supplement')
            signature['keyId'] = 'supplement-key'
            self.rows.append({'supplementId': facts['supplementId'], 'proofId': facts['proofId'], 'sequence': sequence,
                              'kind': facts['kind'], 'canonicalJson': raw.decode(), 'sha256': verifier.digest(raw),
                              'previousSha256': previous, 'coreManifestSha256': self.core,
                              'signature': signature, 'createdAt': STAMP})
            previous = self.rows[-1]['sha256']

    def archive(self, rows=None, descriptor_patch=None, snapshot_patch=None, remove_file=False, legacy=False):
        rows = self.rows if rows is None else rows
        files, package = copy.deepcopy(self.files), copy.deepcopy(self.package)
        if not legacy:
            descriptor = {'path': 'proof-supplements.json', 'sequence': len(rows),
                          'sha256': rows[-1]['sha256'] if rows else self.core, 'snapshotAt': STAMP}
            descriptor.update(descriptor_patch or {})
            snapshot = {'schema': 'packproof.signed-supplement-snapshot.v1', 'proofId': 'proof_fixture',
                        'snapshotAt': STAMP, 'coreManifestSha256': self.core, 'sequence': len(rows),
                        'sha256': rows[-1]['sha256'] if rows else self.core, 'supplements': rows,
                        'snapshotLimit': 'Received snapshot only'}
            snapshot.update(snapshot_patch or {})
            package['sources'] = {'signedSupplements': descriptor}
            if not remove_file:
                files['proof-supplements.json'] = canon(snapshot)
        files['package.json'] = canon(package)
        files['integrity/hashes.json'] = canon({name: verifier.digest(data) for name, data in files.items()})
        path = self.folder / 'signed-supplements.zip'
        with zipfile.ZipFile(path, 'w') as archive:
            for name, data in files.items():
                archive.writestr(name, data)
        return path

    def check(self, **kwargs):
        return verifier.verify(self.archive(**kwargs), now=NOW, registry_path=self.write_registry(),
                               authority_key_path=self.folder / 'authority.pem', authority_key_id='pinned-authority')

    def rejects(self, expected, **kwargs):
        with self.assertRaises(verifier.VerificationError) as result:
            self.check(**kwargs)
        self.assertEqual(result.exception.status, expected)

    def test_received_chain_checks_each_signature_and_declared_head(self):
        result = self.check()
        self.assertEqual(result['status'], 'VERIFIED')
        chain = result['supplements']
        self.assertEqual(chain['status'], 'VERIFIED_RECEIVED_SNAPSHOT')
        self.assertEqual(chain['sequence'], 3)
        self.assertEqual(chain['headSha256'], self.rows[-1]['sha256'])
        self.assertTrue(chain['chainContinuityVerified'])
        self.assertTrue(chain['signaturesVerified'])
        self.assertTrue(chain['fullyVerifiedReceivedChain'])
        self.assertFalse(chain['coveredByRootSignature'])
        self.assertEqual(chain['completeness'], 'RECEIVED_SNAPSHOT_ONLY')
        self.assertFalse(chain['snapshotTimeIndependentlyAttested'])
        self.assertEqual(chain['currentRevocationKnowledge'], 'UNAVAILABLE_OFFLINE')

    def test_missing_declared_file_does_not_become_legacy(self):
        self.rejects('MISSING_FILES', remove_file=True)

    def test_missing_middle_duplicate_and_reordered_entries_fail_without_sorting(self):
        for rows in [self.rows[1:], [self.rows[0], self.rows[2]], [self.rows[0], self.rows[0]], list(reversed(self.rows))]:
            with self.subTest(order=[row['sequence'] for row in rows]):
                self.rejects('SUPPLEMENT_CHAIN_INVALID', rows=rows)

    def test_tampered_bytes_fail_even_after_outer_archive_inventory_is_recomputed(self):
        rows = copy.deepcopy(self.rows)
        rows[0]['canonicalJson'] = rows[0]['canonicalJson'].replace('Synthetic correction', 'Tampered assertion')
        self.rejects('SUPPLEMENT_INTEGRITY_FAILURE', rows=rows)
        # Altering both a signed view's digest and its declared head cannot repair the signature.
        row = rows[0]
        row['sha256'] = verifier.digest(row['canonicalJson'].encode())
        result = self.check(rows=[row])
        self.assertEqual(result['status'], 'SUPPLEMENT_INVALID_SIGNATURE')
        self.assertTrue(result['signatureVerified'])
        self.assertFalse(result['supplements']['signaturesVerified'])

    def test_scope_ancestry_head_count_and_snapshot_date_are_bound(self):
        self.rejects('SUPPLEMENT_SNAPSHOT_MISMATCH', descriptor_patch={'sha256': '0' * 64})
        self.rejects('SUPPLEMENT_SNAPSHOT_MISMATCH', snapshot_patch={'proofId': 'foreign-proof'})
        self.rejects('SUPPLEMENT_SNAPSHOT_MISMATCH', snapshot_patch={'coreManifestSha256': '0' * 64})
        self.rejects('SUPPLEMENT_SNAPSHOT_MISMATCH', descriptor_patch={'sequence': 9})
        self.rejects('SUPPLEMENT_SNAPSHOT_MISMATCH', descriptor_patch={'snapshotAt': '2027-01-01T00:00:00Z'})
        rows = copy.deepcopy(self.rows)
        rows[0]['previousSha256'] = '0' * 64
        self.rejects('SUPPLEMENT_CHAIN_INVALID', rows=rows)

    def test_unknown_supplement_key_qualifies_a_valid_root(self):
        self.registry['keys'] = self.registry['keys'][:1]
        result = self.check()
        self.assertTrue(result['signatureVerified'])
        self.assertEqual(result['status'], 'SUPPLEMENT_UNKNOWN_KEY')
        self.assertEqual(result['supplements']['status'], 'UNKNOWN_KEY')
        self.assertFalse(result['supplements']['fullyVerifiedReceivedChain'])

    def test_retired_supplement_key_preserves_valid_history_and_rejects_later_signing(self):
        key = self.registry['keys'][1]
        key.update(status='RETIRED', statusEffectiveAt='2026-09-06T00:00:00Z')
        for row in self.rows:
            row['signature']['signedAt'] = '2026-09-05T00:00:00Z'
        result = self.check()
        self.assertEqual(result['status'], 'VERIFIED')
        self.assertTrue(result['supplements']['fullyVerifiedReceivedChain'])
        self.rows[-1]['signature']['signedAt'] = STAMP
        result = self.check()
        self.assertEqual(result['status'], 'SUPPLEMENT_KEY_OUTSIDE_VALIDITY')
        self.assertTrue(result['supplements']['signaturesVerified'])
        self.assertFalse(result['supplements']['keysTrustedAtSnapshot'])

    def test_compromised_or_revoked_supplement_key_cannot_be_rescued_by_backdating(self):
        for status in ['COMPROMISED', 'REVOKED']:
            self.registry['keys'][1].update(status=status, statusEffectiveAt='2026-09-06T00:00:00Z')
            for row in self.rows:
                row['signature']['signedAt'] = '2026-08-01T00:00:00Z'
            result = self.check()
            self.assertTrue(result['signatureVerified'])
            self.assertTrue(result['supplements']['signaturesVerified'])
            self.assertFalse(result['supplements']['keysTrustedAtSnapshot'])
            self.assertEqual(result['status'], 'SUPPLEMENT_' + status + '_KEY')

    def test_rsa_pss_supplement_signature_uses_the_independently_selected_algorithm(self):
        self.registry['keys'][1].update(algorithm='RSASSA_PSS_SHA_256',
                                        publicKeyPem=(self.folder / 'rsa-authority.pem').read_text())
        for row in self.rows:
            row['signature'] = self.sign(row['canonicalJson'].encode(), 'rsa-authority')
            row['signature']['keyId'] = 'supplement-key'
        result = self.check()
        self.assertEqual(result['status'], 'VERIFIED')
        self.assertTrue(result['supplements']['fullyVerifiedReceivedChain'])
        self.registry['keys'][1]['algorithm'] = 'ECDSA_SHA_256'
        self.assertEqual(self.check()['status'], 'SUPPLEMENT_INVALID_SIGNATURE')

    def test_legacy_external_trust_list_can_authenticate_the_received_chain(self):
        trust = {'schema': 'packproof.trust-list.v1', 'generatedAt': self.registry['publishedAt'],
                 'expiresAt': self.registry['nextReviewAt'],
                 'keys': [{field: key[field] for field in ['keyId', 'algorithm', 'publicKeyPem', 'status']}
                          for key in self.registry['keys']]}
        path = self.folder / 'external-trust.json'
        path.write_bytes(canon(trust))
        result = verifier.verify(self.archive(), now=NOW, trust_path=path)
        self.assertEqual(result['status'], 'VERIFIED')
        self.assertTrue(result['supplements']['fullyVerifiedReceivedChain'])
        trust['keys'][1]['status'] = 'REVOKED'
        path.write_bytes(canon(trust))
        result = verifier.verify(self.archive(), now=NOW, trust_path=path)
        self.assertEqual(result['status'], 'SUPPLEMENT_REVOKED_KEY')

    def test_empty_and_legacy_snapshots_preserve_explicit_limits(self):
        empty = self.check(rows=[])
        self.assertEqual(empty['status'], 'VERIFIED')
        self.assertEqual(empty['supplements']['status'], 'EMPTY_RECEIVED_SNAPSHOT')
        self.assertEqual(empty['supplements']['headSha256'], self.core)
        self.assertFalse(empty['supplements']['signaturesVerified'])
        legacy = self.check(legacy=True)
        self.assertEqual(legacy['status'], 'VERIFIED')
        self.assertEqual(legacy['supplements']['status'], 'NOT_INCLUDED_LEGACY_OR_UNDECLARED')
        self.assertFalse(legacy['supplements']['chainContinuityVerified'])

    def test_valid_prefix_can_only_establish_received_snapshot_not_latest_completeness(self):
        result = self.check(rows=self.rows[:1])
        self.assertEqual(result['status'], 'VERIFIED')
        self.assertEqual(result['supplements']['sequence'], 1)
        self.assertEqual(result['supplements']['completeness'], 'RECEIVED_SNAPSHOT_ONLY')
        self.assertEqual(result['supplements']['currentRevocationKnowledge'], 'UNAVAILABLE_OFFLINE')
        self.assertNotIn('latest', result['supplements'])

    def test_stale_registry_keeps_supplement_math_separate_from_trust(self):
        self.registry['nextReviewAt'] = '2026-09-07T12:00:00Z'
        result = self.check()
        self.assertEqual(result['status'], 'TRUST_STALE')
        self.assertTrue(result['supplements']['signaturesVerified'])
        self.assertEqual(result['supplements']['status'], 'TRUST_STALE')
        self.assertFalse(result['supplements']['fullyVerifiedReceivedChain'])


if __name__ == '__main__':
    unittest.main()
