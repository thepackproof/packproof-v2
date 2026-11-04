"""Offline report boundaries using an existing independently verified synthetic package.

The recorded key is public test material. No production identity, customer media,
network service, or PackProof backend is needed to run these checks.
"""
import base64
import contextlib
import copy
import datetime as dt
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('packproof_report_verify', HERE / 'verify.py')
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
envelope_spec = importlib.util.spec_from_file_location('packproof_report_envelope', HERE / 'envelope.py')
envelope = importlib.util.module_from_spec(envelope_spec)
envelope_spec.loader.exec_module(envelope)
NOW = dt.datetime(2026, 10, 22, 5, tzinfo=dt.timezone.utc)


class EnvelopeReportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='packproof-envelope-report-')
        self.folder = Path(self.temporary.name)
        fixture_path = HERE.parent / 'backend/tests/fixtures/envelope-kms-20261022.json'
        self.fixture = json.loads(fixture_path.read_text(encoding='utf-8'))
        self.files = {name: base64.b64decode(value) for name, value in self.fixture['files'].items()}
        self.trust_path = self.folder / 'independently-pinned-trust.json'
        self.trust_path.write_text(json.dumps(self.fixture['trust']), encoding='utf-8')
        self.artifact_path = 'manifest.json'

    def tearDown(self):
        self.temporary.cleanup()

    def verify(self):
        try:
            import cryptography
            import rfc8785
        except ImportError:
            self.skipTest('Install the pinned verifier/requirements-envelope.txt dependencies')
        return envelope.verify_package(
            json.loads(self.files['package.json']), set(self.files), self.files.__getitem__,
            self.trust_path, NOW, self.fixture.get('expectedProof'), self.fixture.get('expectedDigest'))

    def report_result(self):
        """Synthetic presentation input; this does not perform cryptographic validation."""
        return {'status': 'VERIFIED', 'profile': envelope.PROFILE, 'proofId': 'proof_report_fixture',
                'recordType': 'CORE', 'recordId': 'manifest_report_fixture',
                'issuer': 'https://fixture.invalid', 'issuedAt': '2026-10-22T04:30:00.000Z',
                'hashIntegrity': 'PASS', 'issuerSignature': 'VALID', 'coverage': 'COMPLETE_FOR_DECLARED_SCOPE',
                'keyStatus': 'ACTIVE', 'keyTrustedAtIssue': True, 'timestamp': 'NOT_PRESENT',
                'truthOfRecordedScene': 'NOT_ASSESSED', 'signatureVerified': True,
                'trust': {'status': 'CURRENT_SNAPSHOT', 'currentRevocationKnowledge': 'UNAVAILABLE_OFFLINE'},
                'files': [{'path': 'manifest.json', 'status': 'HASH_MATCHED', 'sha256': 'a' * 64,
                           'expectedByteSize': 55, 'actualByteSize': 55}], 'omissions': [], 'limitations': []}

    def test_report_separates_signed_identity_integrity_trust_coverage_and_physical_truth(self):
        result = self.report_result()
        report = verifier.render_html_report(result)
        for label in ('File integrity', 'Issuer signature mathematics', 'Declared coverage',
                      'Signing key status', 'Independent timestamp', 'Truth of recorded scene',
                      'Current revocation knowledge', 'Expected bytes', 'Received bytes'):
            self.assertIn(label, report)
        self.assertIn('NOT_PRESENT', report)
        self.assertIn('NOT_ASSESSED', report)
        self.assertIn('UNAVAILABLE_OFFLINE', report)
        self.assertNotIn('Signed supplement chain', report)

    def test_verified_signed_scope_includes_expected_and_received_byte_counts(self):
        result = self.verify()
        self.assertEqual(result['status'], 'VERIFIED')
        self.assertEqual(result['recordType'], 'CORE')
        self.assertTrue(result['recordId'])
        item = next(item for item in result['files'] if item['path'] == self.artifact_path)
        self.assertEqual(item['expectedByteSize'], len(self.files[self.artifact_path]))
        self.assertEqual(item['actualByteSize'], item['expectedByteSize'])

    def test_incomplete_report_keeps_changed_missing_and_omitted_findings_separate(self):
        result = self.report_result()
        result.update({'status': 'INTEGRITY_INCOMPLETE', 'hashIntegrity': 'FAIL', 'coverage': 'PARTIAL',
                       'keyStatus': 'COMPROMISED', 'keyTrustedAtIssue': False,
                       'modified': ['changed.mp4'], 'missing': ['absent.jpg'],
                       'omissions': [{'path': 'withheld.pdf', 'reason': 'Excluded by disclosure policy'}]})
        report = verifier.render_html_report(result)
        self.assertIn('COMPROMISED', report)
        self.assertIn('<th scope="row">Issuer signature mathematics</th><td>VALID</td>', report)
        self.assertIn('<th scope="row">Key trusted at reported issue time</th><td>No</td>', report)
        self.assertIn('Changed files</h2><pre>[\n  &quot;changed.mp4&quot;', report)
        self.assertIn('Missing included files</h2><pre>[\n  &quot;absent.jpg&quot;', report)
        self.assertIn('withheld.pdf', report)
        self.assertIn('Excluded by disclosure policy', report)
        self.assertIn('INTEGRITY INCOMPLETE', report)

    def test_changed_file_keeps_valid_signature_but_fails_byte_integrity(self):
        self.files[self.artifact_path] = b'changed file'
        result = self.verify()
        self.assertEqual(result['issuerSignature'], 'VALID')
        self.assertEqual(result['hashIntegrity'], 'FAIL')
        self.assertEqual(result['coverage'], 'PARTIAL')
        self.assertEqual(result['modified'], [self.artifact_path])
        item = next(item for item in result['files'] if item['path'] == self.artifact_path)
        self.assertEqual(item['actualByteSize'], 12)
        self.assertNotEqual(item['expectedByteSize'], item['actualByteSize'])
        report = verifier.render_html_report(result)
        self.assertIn('Changed files', report)
        self.assertIn('HASH_MISMATCH', report)
        self.assertNotEqual(result['status'], 'VERIFIED')

    def test_missing_file_is_not_reported_as_changed_or_intentionally_excluded(self):
        del self.files[self.artifact_path]
        result = self.verify()
        self.assertEqual(result['issuerSignature'], 'VALID')
        self.assertEqual(result['hashIntegrity'], 'INCOMPLETE')
        self.assertEqual(result['missing'], [self.artifact_path])
        self.assertEqual(result['modified'], [])
        self.assertEqual(result['omissions'], [])
        item = next(item for item in result['files'] if item['path'] == self.artifact_path)
        self.assertIsNone(item['actualByteSize'])
        report = verifier.render_html_report(result)
        self.assertIn('Missing included files', report)
        self.assertIn('MISSING', report)

    def test_report_does_not_hide_compromised_key_behind_valid_signature(self):
        trust = copy.deepcopy(self.fixture['trust'])
        trust['keys'][0]['status'] = 'COMPROMISED'
        trust['keys'][0]['statusEffectiveAt'] = trust['publishedAt']
        self.trust_path.write_text(json.dumps(trust), encoding='utf-8')
        result = self.verify()
        self.assertEqual(result['issuerSignature'], 'VALID')
        self.assertEqual(result['keyStatus'], 'COMPROMISED')
        self.assertFalse(result['keyTrustedAtIssue'])
        self.assertNotEqual(result['status'], 'VERIFIED')
        self.assertIn('COMPROMISED', verifier.render_html_report(result))

    def test_untrusted_text_remains_inert_in_report(self):
        result = self.report_result()
        payload = '<script src="https://attacker.invalid/a.js"></script>'
        result['issuer'] = payload
        result['files'][0]['path'] = payload
        result['omissions'] = [{'path': payload, 'reason': payload}]
        result['limitations'] = [payload]
        report = verifier.render_html_report(result)
        self.assertNotIn('<script', report)
        self.assertNotIn('<iframe', report)
        self.assertNotIn('<a href=', report)
        self.assertIn('&lt;script', report)
        self.assertIn("default-src 'none'", report)
        self.assertIn('not cryptographically signed', report)

    def test_cli_report_cannot_overwrite_input_archive(self):
        archive = self.folder / 'proof.pkpr'
        with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_STORED) as package:
            for name, content in self.files.items():
                package.writestr(name, content)
        original_bytes = archive.read_bytes()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            status = verifier.main([str(archive), '--envelope-trust', str(self.trust_path),
                                    '--html-report', str(archive)])
        self.assertEqual(status, 1)
        self.assertIn('reportError', json.loads(output.getvalue()))
        self.assertEqual(archive.read_bytes(), original_bytes)

    def test_legacy_report_keeps_legacy_signature_and_supplement_findings(self):
        report = verifier.render_html_report({'status': 'UNSIGNED', 'signatureVerified': False,
                                             'supplements': {'status': 'NOT_INCLUDED_LEGACY_OR_UNDECLARED'}})
        self.assertIn('Signature verified', report)
        self.assertIn('Signed supplement chain', report)
        self.assertNotIn('Issuer signature mathematics', report)


if __name__ == '__main__':
    unittest.main()
