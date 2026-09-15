"""Independent negative fixtures for signed received lifecycle snapshots (synthetic keys/media)."""
import copy
import json
import unittest
import zipfile
import test_signed_supplements as fixture

verifier, NOW, STAMP, canon = fixture.verifier, fixture.NOW, fixture.STAMP, fixture.canon


class LifecycleSnapshotTests(unittest.TestCase):
    setUpClass = classmethod(fixture.SignedSupplementTests.setUpClass.__func__)
    tearDownClass = classmethod(fixture.SignedSupplementTests.tearDownClass.__func__)
    sign = fixture.SignedSupplementTests.sign
    write_registry = fixture.SignedSupplementTests.write_registry

    def setUp(self):
        fixture.SignedSupplementTests.setUp(self)
        source = fixture.SignedSupplementTests.archive(self)
        with zipfile.ZipFile(source) as archive:
            self.base = {name: archive.read(name) for name in archive.namelist() if name != 'integrity/hashes.json'}
        self.facts = {'version': 1, 'domain': 'PACKPROOF_LIFECYCLE_SNAPSHOT', 'snapshotId': 'snapshot_fixture',
                      'proofId': 'proof_fixture', 'transactionId': None, 'tenantId': 'tenant_fixture',
                      'actorUserId': 'seller-fixture', 'purpose': 'REVIEW', 'scope': 'SEALED_COMMERCE_LIFECYCLE',
                      'createdAt': STAMP, 'cutoffAt': STAMP,
                      'root': {'manifestId': 'manifest_fixture', 'sha256': self.core},
                      'supplements': [{field: row[field] for field in ('supplementId', 'sequence', 'sha256', 'previousSha256')} for row in self.rows],
                      'stages': [], 'watermark': {'supplementSequence': len(self.rows), 'supplementSha256': self.rows[-1]['sha256']},
                      'limitations': {'completeness': 'RECEIVED_SNAPSHOT_ONLY', 'freshness': 'UNKNOWN_OFFLINE',
                                      'currentRevocationKnowledge': 'UNAVAILABLE_OFFLINE',
                                      'excluded': ['UNSEALED_STAGES', 'UNSEALED_OBSERVATIONS', 'EVIDENCE_BYTES']}}

    def archive(self, mutate=None, facts=None):
        facts = self.facts if facts is None else facts
        files = copy.deepcopy(self.base)
        raw = canon(facts)
        envelope = {'canonicalJson': raw.decode(), 'sha256': verifier.digest(raw), 'signature': self.sign(raw, 'signer')}
        package = json.loads(files['package.json'])
        package['sources']['lifecycleSnapshot'] = {'path': 'lifecycle/snapshot.json', 'snapshotId': facts['snapshotId'], 'sha256': envelope['sha256']}
        files['package.json'] = canon(package)
        files['lifecycle/snapshot.json'] = canon(envelope)
        if mutate:
            mutate(files)
        files['integrity/hashes.json'] = canon({name: verifier.digest(data) for name, data in files.items()})
        target = self.folder / 'lifecycle.zip'
        with zipfile.ZipFile(target, 'w') as archive:
            for name, data in files.items():
                archive.writestr(name, data)
        return target

    def check(self, mutate=None, facts=None, **kwargs):
        return verifier.verify(self.archive(mutate, facts), now=NOW, registry_path=self.write_registry(),
                               authority_key_path=self.folder / 'authority.pem', authority_key_id='pinned-authority', **kwargs)

    def rejects(self, status, **kwargs):
        with self.assertRaises(verifier.VerificationError) as result:
            self.check(**kwargs)
        self.assertEqual(result.exception.status, status)

    def test_independent_required_context_and_received_snapshot_limits(self):
        result = self.check(expected_proof='proof_fixture', expected_tenant='tenant_fixture', expected_snapshot=verifier.digest(canon(self.facts)))
        self.assertEqual(result['status'], 'VERIFIED')
        signed = result['lifecycleSnapshot']
        self.assertTrue(signed['signatureVerified'])
        self.assertTrue(signed['expectedSnapshotMatched'])
        self.assertEqual(signed['freshness'], 'UNKNOWN_OFFLINE')
        self.assertEqual(signed['completeness'], 'RECEIVED_SNAPSHOT_ONLY')
        self.assertEqual(signed['currentRevocationKnowledge'], 'UNAVAILABLE_OFFLINE')
        self.assertEqual(result['attestationVerification'], 'NOT_INDEPENDENTLY_CHECKED')

    def test_changed_signature_and_missing_snapshot_remain_distinct(self):
        def modified(files):
            envelope = json.loads(files['lifecycle/snapshot.json'])
            envelope['canonicalJson'] = envelope['canonicalJson'].replace('seller-fixture', 'someone-else')
            files['lifecycle/snapshot.json'] = canon(envelope)
        self.rejects('LIFECYCLE_SNAPSHOT_MISMATCH', mutate=modified)
        self.rejects('MISSING_FILES', mutate=lambda files: files.pop('lifecycle/snapshot.json'))
        def forged(files):
            modified(files)
            envelope = json.loads(files['lifecycle/snapshot.json'])
            envelope['sha256'] = verifier.digest(envelope['canonicalJson'].encode())
            files['lifecycle/snapshot.json'] = canon(envelope)
            package = json.loads(files['package.json'])
            package['sources']['lifecycleSnapshot']['sha256'] = envelope['sha256']
            files['package.json'] = canon(package)
        result = self.check(mutate=forged)
        self.assertTrue(result['signatureVerified'])
        self.assertEqual(result['status'], 'LIFECYCLE_INVALID_SIGNATURE')

    def test_wrong_proof_tenant_root_and_expected_old_snapshot_fail(self):
        self.rejects('PROOF_CONTEXT_MISMATCH', expected_proof='other-proof')
        self.rejects('TENANT_CONTEXT_MISMATCH', expected_tenant='other-tenant')
        self.rejects('LIFECYCLE_SNAPSHOT_MISMATCH', expected_snapshot='0' * 64)
        for patch in [{'proofId': 'other-proof'}, {'transactionId': 'another-order'}, {'root': {'manifestId': 'manifest_fixture', 'sha256': '0' * 64}}]:
            self.rejects('LIFECYCLE_SNAPSHOT_MISMATCH', facts={**self.facts, **patch})
        self.rejects('TENANT_BINDING_NOT_ESTABLISHED', facts={**self.facts, 'tenantId': None}, expected_tenant='tenant_fixture')
        self.assertEqual(self.check(facts={**self.facts, 'tenantId': None})['lifecycleSnapshot']['tenantBinding'], 'NOT_ESTABLISHED')

    def test_omitted_chain_and_whole_snapshot_cannot_meet_expected_snapshot(self):
        def omit_chain(files):
            files.pop('proof-supplements.json')
            package = json.loads(files['package.json'])
            package['sources'].pop('signedSupplements')
            files['package.json'] = canon(package)
        self.rejects('LIFECYCLE_SNAPSHOT_MISMATCH', mutate=omit_chain)
        def omit_snapshot(files):
            files.pop('lifecycle/snapshot.json')
            package = json.loads(files['package.json'])
            package['sources'].pop('lifecycleSnapshot')
            files['package.json'] = canon(package)
        self.rejects('LIFECYCLE_SNAPSHOT_MISMATCH', mutate=omit_snapshot, expected_snapshot=verifier.digest(canon(self.facts)))
        self.assertEqual(self.check(mutate=omit_snapshot)['lifecycleSnapshot']['status'], 'NOT_INCLUDED_LEGACY_OR_UNDECLARED')

    def test_signed_inventory_binds_stage_digest_type_ancestry_and_cutoff(self):
        stage = {'schema': 'packproof.commerce-stage.v1', 'proofId': 'proof_fixture', 'stageId': 'receipt_fixture',
                 'type': 'RECEIPT', 'baseManifestSha256': self.core, 'previousStage': None, 'finalizedAt': STAMP, 'evidence': []}
        stage_bytes = canon(stage)
        stage_sha = verifier.digest(stage_bytes)
        facts = {**self.facts, 'stages': [{'stageId': 'receipt_fixture', 'type': 'RECEIPT', 'sha256': stage_sha, 'finalizedAt': STAMP}]}
        def include_stage(files):
            files['lifecycle/receipt_fixture/manifest.json'] = stage_bytes
            files['lifecycle/stages.json'] = canon([{'stageId': 'receipt_fixture', 'sha256': stage_sha,
                                                   'manifestPath': 'lifecycle/receipt_fixture/manifest.json', 'evidence': []}])
        self.assertEqual(self.check(mutate=include_stage, facts=facts)['status'], 'VERIFIED')
        self.rejects('LIFECYCLE_SNAPSHOT_MISMATCH', facts=facts)
        self.rejects('LIFECYCLE_SNAPSHOT_MISMATCH', mutate=include_stage)
        wrong_type = copy.deepcopy(facts)
        wrong_type['stages'][0]['type'] = 'RETURN'
        self.rejects('LIFECYCLE_SNAPSHOT_MISMATCH', mutate=include_stage, facts=wrong_type)
        self.rejects('LIFECYCLE_SNAPSHOT_MISMATCH', facts={**self.facts, 'cutoffAt': '2026-09-06T00:00:00Z'})

    def test_unsupported_profiles_and_injected_derivation_parent_never_verify(self):
        self.rejects('UNSUPPORTED_VERSION', facts={**self.facts, 'version': 2})
        def derivative(files):
            files['archive.json'] = canon({'schema': 'packproof.proof-archive.v1', 'canonicalization': 'packproof.sorted-json.v1',
                                          'derivatives': [{'sourceEvidenceId': 'another-proof-secret', 'sha256': '0' * 64}]})
        self.rejects('UNSUPPORTED_DERIVATION_PROFILE', mutate=derivative)

    def test_unknown_compromised_and_stale_snapshot_trust_keep_math_separate(self):
        self.registry['keys'][0].update(status='COMPROMISED', statusEffectiveAt='2026-09-06T00:00:00Z')
        result = self.check()
        self.assertEqual(result['lifecycleSnapshot']['status'], 'COMPROMISED_KEY')
        self.assertTrue(result['lifecycleSnapshot']['signatureVerified'])
        self.registry['keys'][0].update(status='ACTIVE', statusEffectiveAt=None)
        self.registry['nextReviewAt'] = '2026-09-07T12:00:00Z'
        result = self.check()
        self.assertEqual(result['lifecycleSnapshot']['status'], 'TRUST_STALE')
        self.assertTrue(result['lifecycleSnapshot']['signatureVerified'])
        self.registry['keys'] = self.registry['keys'][1:]
        self.assertEqual(self.check()['lifecycleSnapshot']['status'], 'UNKNOWN_KEY')

    def test_original_changed_missing_and_explicitly_omitted(self):
        self.rejects('MODIFIED_FILES', mutate=lambda files: files.update({'media/original.bin': b'changed'}))
        self.rejects('INVALID_PACKAGE', mutate=lambda files: files.pop('media/original.bin'))
        def omit(files):
            files.pop('media/original.bin')
            source = json.loads(files['manifest.json'])['evidence'][0]
            files['integrity/evidence.json'] = canon([{**source, 'status': 'OMITTED', 'reason': 'UNAVAILABLE'}])
        result = self.check(mutate=omit)
        self.assertEqual(result['status'], 'OMITTED_FILES')
        self.assertTrue(result['lifecycleSnapshot']['signatureVerified'])
        self.assertFalse(result['completeMedia'])


if __name__ == '__main__':
    unittest.main()
