"""Independent closed-schema and public synthetic ES256 operational fixtures.

The public fixture was produced by Node's OpenSSL-backed signer; verification
uses Python cryptography, not the backend signer or its ECDSA DER conversion.
"""
import base64
import copy
import datetime as dt
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

import operational_snapshot as operational
import verify as verifier

HERE = Path(__file__).resolve().parent
NOW = dt.datetime(2026, 11, 4, 12, tzinfo=dt.timezone.utc)
try:
    import cryptography
    import rfc8785
    HAS_CRYPTO = True
except ImportError:
    HAS_CRYPTO = False


class OperationalSchemaTests(unittest.TestCase):
    def setUp(self):
        self.fixture = json.loads((HERE / 'operational-snapshot-fixture.json').read_text(encoding='utf-8'))
        self.files = {name: base64.b64decode(value) for name, value in self.fixture['files'].items()}
        self.manifest = operational.json_value(self.files[operational.MANIFEST_PATH])

    def test_closed_schema_accepts_frozen_membership_and_late_entity_in_later_revision(self):
        artifacts, omissions = operational.validate_manifest(self.manifest)
        self.assertEqual(set(artifacts), {'evidence_fixture'})
        self.assertEqual(omissions, {})
        prior = operational.json_value(self.files[operational.PRIOR_PATH])
        operational.validate_manifest(prior)
        self.assertEqual(len(prior['entities']), 1)
        self.assertEqual(len(self.manifest['entities']), 2)
        self.assertEqual(hashlib.sha256(self.files[operational.PRIOR_PATH]).hexdigest(), self.manifest['priorSnapshot']['manifestSha256'])

    def test_core_inventory_cannot_be_silently_dropped_or_substituted(self):
        core = operational.json_value(self.files[operational.CORE_PATH])
        artifacts, omissions = operational.validate_manifest(self.manifest)
        operational.validate_core_membership(core, self.manifest, artifacts, omissions)
        with self.assertRaisesRegex(ValueError, 'silently absent'):
            operational.validate_core_membership(core, self.manifest, {}, {})
        changed = copy.deepcopy(artifacts); changed['evidence_fixture']['storage']['versionId'] = 'substituted-version'
        with self.assertRaisesRegex(ValueError, 'substituted'):
            operational.validate_core_membership(core, self.manifest, changed, {})

    def test_unknown_root_and_row_fields_require_a_new_profile(self):
        for mutate in (lambda m: m.update({'uncheckedAssertion': True}), lambda m: m['entities'][0].update({'verifiedPhysicalTruth': True})):
            value = copy.deepcopy(self.manifest); mutate(value)
            with self.assertRaises(ValueError):
                operational.validate_manifest(value)

    def test_unknown_manifest_or_evaluation_schema_is_rejected(self):
        for key in ('profile', 'evaluation'):
            value = copy.deepcopy(self.manifest)
            if key == 'profile': value[key] = 'packproof.operational-record-manifest.v999'
            else: value[key]['version'] = 'packproof.requirement-evaluation.v999'
            with self.assertRaises(ValueError): operational.validate_manifest(value)

    def test_no_operational_row_may_arrive_after_the_frozen_evaluation_time(self):
        self.manifest['entities'][1]['created_at'] = '2026-11-03T12:00:00.001Z'
        with self.assertRaisesRegex(ValueError, 'cutoff'): operational.validate_manifest(self.manifest)

    def test_cross_proof_and_missing_subject_links_are_rejected(self):
        for key, value in [('proof_id', 'different-proof'), ('subject_id', 'undeclared-subject'), ('evidence_id', 'undeclared-artifact')]:
            manifest = copy.deepcopy(self.manifest); manifest['links'][0][key] = value
            with self.assertRaises(ValueError): operational.validate_manifest(manifest)

    def test_artifact_and_omission_membership_is_disjoint(self):
        self.manifest['omissions'] = [{'artifactId': 'evidence_fixture', 'reason': 'WITHHELD', 'detail': 'Explicit omission'}]
        with self.assertRaisesRegex(ValueError, 'omission'): operational.validate_manifest(self.manifest)

    def test_missing_quarantined_and_withheld_evidence_are_distinct_and_never_satisfy_a_requirement(self):
        for reason in ('MISSING', 'QUARANTINED', 'WITHHELD', 'UNAVAILABLE', 'PENDING'):
            manifest = copy.deepcopy(self.manifest)
            manifest['artifacts'] = []
            manifest['omissions'] = [{'artifactId': 'evidence_fixture', 'reason': reason, 'detail': 'Explicit signed omission'}]
            requirement = manifest['requirements'][0]
            requirement['matching_artifact_ids'] = []
            requirement['evaluation_status'] = 'missing'
            artifacts, omissions = operational.validate_manifest(manifest)
            self.assertFalse(artifacts); self.assertEqual(omissions['evidence_fixture']['reason'], reason)
            requirement['matching_artifact_ids'] = ['evidence_fixture']
            with self.assertRaises(ValueError): operational.validate_manifest(manifest)

    def test_requirement_matches_are_recomputed_using_type_time_and_subject(self):
        mutations = [lambda m: m['artifacts'][0].update({'evidenceType': 'DELIVERY_DOCUMENT'}),
                     lambda m: m['requirements'][0].update({'due_at': '2026-11-03T09:59:59.000Z'}),
                     lambda m: m['links'].clear(),
                     lambda m: m['requirements'][0].update({'matching_artifact_ids': [], 'evaluation_status': 'missing'})]
        for mutate in mutations:
            manifest = copy.deepcopy(self.manifest); mutate(manifest)
            with self.assertRaisesRegex(ValueError, 'evaluation'): operational.validate_manifest(manifest)

    def test_deadline_uses_server_acceptance_and_source_artifact_requires_explicit_link(self):
        manifest = copy.deepcopy(self.manifest)
        artifact, requirement = manifest['artifacts'][0], manifest['requirements'][0]
        requirement['due_at'] = '2026-11-03T10:30:00.000Z'
        artifact['source']['acceptedAt'] = '2026-11-03T11:00:00.000Z'
        with self.assertRaisesRegex(ValueError, 'evaluation'): operational.validate_manifest(manifest)
        requirement['matching_artifact_ids'] = []; requirement['evaluation_status'] = 'missing'
        operational.validate_manifest(manifest)
        artifact['kind'] = 'SOURCE_ARTIFACT'; artifact['source'].update({'acceptedAt': artifact['source']['receivedAt'], 'actorId': 'principal_fixture', 'receiptSha256': 'a' * 64})
        requirement['subject_id'] = manifest['proofId']; manifest['links'] = []
        operational.validate_manifest(manifest)
        artifact['source']['receiptSha256'] = None
        with self.assertRaisesRegex(ValueError, 'receipt commitment'): operational.validate_manifest(manifest)

    def test_waiver_takes_precedence_without_faking_evidence(self):
        requirement = self.manifest['requirements'][0]
        self.manifest['waivers'] = [{'id': 'waiver_fixture', 'requirement_id': requirement['id'], 'reason': 'Explicit administrative exception', 'actor_user_id': 'user_fixture', 'created_at': '2026-11-03T10:00:00.000Z'}]
        requirement['evaluation_status'] = 'waived'
        operational.validate_manifest(self.manifest)
        requirement['evaluation_status'] = 'satisfied'
        with self.assertRaisesRegex(ValueError, 'evaluation'): operational.validate_manifest(self.manifest)

    def test_exact_object_version_and_unique_action_sequence_are_required(self):
        for mutate in (lambda m: m['artifacts'][0]['storage'].update({'versionId': 'null'}), lambda m: m['actions'].append({**m['actions'][0], 'id': 'duplicate-sequence'})):
            manifest = copy.deepcopy(self.manifest); mutate(manifest)
            with self.assertRaises(ValueError): operational.validate_manifest(manifest)

    def test_entity_relationship_cycles_are_rejected(self):
        self.manifest['entities'][0]['parent_id'] = self.manifest['entities'][1]['id']
        self.manifest['entities'][1]['parent_id'] = self.manifest['entities'][0]['id']
        with self.assertRaisesRegex(ValueError, 'Cyclic'): operational.validate_manifest(self.manifest)

    def test_report_separates_operational_claims_math_key_policy_and_truth(self):
        result = {'status': 'INTEGRITY_INCOMPLETE', 'profile': operational.PROFILE, 'proofId': 'proof_fixture', 'organizationId': '<script>organization</script>', 'revision': 2, 'assertion': 'ORGANIZATION_SUBMITTED', 'operationalCoverage': 'FROZEN_DECLARED_REVISION', 'issuerSignature': 'VALID', 'keyStatus': 'COMPROMISED', 'keyTrustedAtIssue': False, 'coverage': 'PARTIAL', 'timestamp': 'NOT_PRESENT', 'truthOfRecordedScene': 'NOT_ASSESSED', 'trust': {'currentRevocationKnowledge': 'UNAVAILABLE_OFFLINE'}}
        report = verifier.render_html_report(result)
        for value in ('Frozen operational revision', 'Operational assertion semantics', 'Issuer signature mathematics', 'COMPROMISED', 'NOT_ASSESSED', 'UNAVAILABLE_OFFLINE'):
            self.assertIn(value, report)
        self.assertNotIn('<script>', report); self.assertIn('&lt;script&gt;', report)
        self.assertNotIn('Signed supplement chain', report)


@unittest.skipUnless(HAS_CRYPTO, 'Install pinned verifier/requirements-envelope.txt dependencies')
class OperationalSignatureTests(unittest.TestCase):
    def setUp(self):
        OperationalSchemaTests.setUp(self)
        self.temporary = tempfile.TemporaryDirectory(prefix='packproof-operational-verifier-')
        self.folder = Path(self.temporary.name)
        self.trust_path = self.folder / 'independently-authenticated-trust.json'
        self.trust_path.write_text(json.dumps(self.fixture['trust']), encoding='utf-8')

    def tearDown(self):
        self.temporary.cleanup()

    def verify(self, **expectations):
        return operational.verify_package(operational.json_value(self.files['package.json']), set(self.files), self.files.__getitem__, self.trust_path, NOW, **expectations)

    def test_valid_public_fixture_verifies_independently_with_required_linkages(self):
        original = copy.deepcopy(self.files)
        result = self.verify(expected_proof=self.manifest['proofId'], expected_digest=self.fixture['expectedManifestSha256'], expected_organization=self.manifest['organizationId'], expected_environment='sandbox', expected_revision=2, expected_core=self.fixture['expectedCoreSha256'], expected_prior=self.fixture['expectedPriorSha256'])
        self.assertEqual(result['status'], 'VERIFIED'); self.assertEqual(result['issuerSignature'], 'VALID')
        self.assertEqual(result['truthOfRecordedScene'], 'NOT_ASSESSED'); self.assertEqual(self.files, original)

    def test_changed_missing_and_intentionally_omitted_artifacts_are_not_conflated(self):
        self.files['originals/evidence_fixture'] = b'changed bytes'
        result = self.verify()
        self.assertEqual(result['issuerSignature'], 'VALID'); self.assertEqual(result['hashIntegrity'], 'FAIL')
        self.assertEqual(result['modified'], ['originals/evidence_fixture']); self.assertEqual(result['omissions'], [])
        del self.files['originals/evidence_fixture']
        result = self.verify()
        self.assertEqual(result['hashIntegrity'], 'INCOMPLETE'); self.assertEqual(result['missing'], ['originals/evidence_fixture']); self.assertEqual(result['modified'], [])

    def test_independently_wrong_tenant_core_prior_environment_or_revision_fails_closed(self):
        for expectations in ({'expected_organization': 'org-other'}, {'expected_environment': 'live'}, {'expected_revision': 1}, {'expected_core': 'a' * 64}, {'expected_prior': 'b' * 64}):
            with self.assertRaisesRegex(ValueError, 'linkage'): self.verify(**expectations)

    def test_changed_core_and_prior_manifest_bytes_fail(self):
        for path in (operational.CORE_PATH, operational.PRIOR_PATH):
            original = self.files[path]; self.files[path] += b' '
            with self.assertRaises(ValueError): self.verify()
            self.files[path] = original

    def test_compromised_key_keeps_valid_math_but_fails_policy(self):
        trust = copy.deepcopy(self.fixture['trust'])
        trust['keys'][0].update({'status': 'COMPROMISED', 'statusEffectiveAt': trust['publishedAt']})
        self.trust_path.write_text(json.dumps(trust), encoding='utf-8')
        result = self.verify()
        self.assertEqual(result['issuerSignature'], 'VALID'); self.assertEqual(result['keyStatus'], 'COMPROMISED')
        self.assertFalse(result['keyTrustedAtIssue']); self.assertNotEqual(result['status'], 'VERIFIED')

    def test_archive_public_keys_cannot_establish_trust(self):
        result = operational.verify_package(operational.json_value(self.files['package.json']), set(self.files), self.files.__getitem__, None, NOW)
        self.assertEqual(result['issuerSignature'], 'UNKNOWN_KEY'); self.assertNotEqual(result['status'], 'VERIFIED')
        self.files['issuer-key.pem'] = self.fixture['trust']['keys'][0]['publicKeyPem'].encode()
        with self.assertRaisesRegex(ValueError, 'Undeclared'): self.verify()

    def test_cli_profile_dispatch_preserves_legacy_interpretation_and_reports_exact_revision(self):
        archive = self.folder / 'operational.pkpr'
        with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_STORED) as package:
            for name, content in self.files.items(): package.writestr(name, content)
        result = verifier.verify(archive, now=NOW, envelope_trust_path=self.trust_path, expected_organization=self.manifest['organizationId'], expected_environment='sandbox', expected_revision=2)
        self.assertEqual(result['status'], 'VERIFIED'); self.assertEqual(result['revision'], 2)



    def make_api_only(self):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        self.synthetic_private_key = ec.generate_private_key(ec.SECP256R1())
        self.manifest['core']['manifestSha256'] = None
        self.manifest['priorSnapshot'] = None
        self.files.pop(operational.CORE_PATH, None)
        self.files.pop(operational.PRIOR_PATH, None)
        artifact = self.manifest['artifacts'][0]
        artifact['kind'] = 'SOURCE_ARTIFACT'
        artifact['evidenceType'] = 'SOURCE_ARTIFACT'
        artifact['source'].update({'kind': 'ORGANIZATION_SERVICE_SUBMITTED', 'actorId': 'principal_fixture', 'receiptSha256': 'a' * 64})
        for requirement in self.manifest['requirements']:
            requirement['accepted_evidence_types'] = ['SOURCE_ARTIFACT']
        trust = copy.deepcopy(self.fixture['trust'])
        trust['keys'][0]['publicKeyPem'] = self.synthetic_private_key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode('ascii')
        self.trust_path.write_text(json.dumps(trust), encoding='utf-8')
        self.resign_current_manifest()

    def resign_current_manifest(self):
        import rfc8785
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec, utils
        encode = lambda value: base64.urlsafe_b64encode(value).rstrip(b'=').decode('ascii')
        manifest_bytes = rfc8785.dumps(self.manifest)
        self.files[operational.MANIFEST_PATH] = manifest_bytes
        jws = operational.json_value(self.files[operational.ENVELOPE_PATH])
        envelope = operational.json_value(operational.b64(jws['payload'], 65536))
        envelope['manifestSha256'] = hashlib.sha256(manifest_bytes).hexdigest()
        jws['payload'] = encode(rfc8785.dumps(envelope))
        signed = self.synthetic_private_key.sign((jws['protected'] + '.' + jws['payload']).encode('ascii'), ec.ECDSA(hashes.SHA256()))
        r, s = utils.decode_dss_signature(signed)
        jws['signature'] = encode(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))
        self.files[operational.ENVELOPE_PATH] = rfc8785.dumps(jws)

    def test_api_only_org_snapshot_verifies_without_a_fabricated_capture_manifest(self):
        self.make_api_only()
        result = self.verify()
        self.assertEqual(result['status'], 'VERIFIED')
        self.assertEqual(result['issuerSignature'], 'VALID')
        self.assertEqual(result['coreCapture'], 'NOT_PRESENT')
        self.assertIsNone(result['coreManifestSha256'])
        self.assertEqual(result['assertion'], 'ORGANIZATION_SUBMITTED')
        self.assertEqual(result['truthOfRecordedScene'], 'NOT_ASSESSED')

    def test_api_only_package_cannot_satisfy_an_independently_required_core(self):
        self.make_api_only()
        with self.assertRaisesRegex(ValueError, 'linkage'):
            self.verify(expected_core=self.fixture['expectedCoreSha256'])
        self.files[operational.CORE_PATH] = base64.b64decode(self.fixture['files'][operational.CORE_PATH])
        with self.assertRaisesRegex(ValueError, 'Undeclared'):
            self.verify()

    def test_core_binding_cannot_disappear_after_a_finalized_prior_snapshot(self):
        prior_link = copy.deepcopy(self.manifest['priorSnapshot'])
        self.make_api_only()
        self.manifest['priorSnapshot'] = prior_link
        self.files[operational.PRIOR_PATH] = base64.b64decode(self.fixture['files'][operational.PRIOR_PATH])
        self.resign_current_manifest()
        with self.assertRaisesRegex(ValueError, 'core|linkage'):
            self.verify()


if __name__ == '__main__':
    unittest.main()
