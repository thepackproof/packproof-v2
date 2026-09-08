"""Real offline cryptographic checks; all keys and footage below are synthetic fixtures."""
import base64
import copy
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('packproof_verify', HERE / 'verify.py')
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
NOW = dt.datetime(2026, 9, 7, 12, tzinfo=dt.timezone.utc)
STAMP = '2026-09-07T11:00:00.000Z'


class SignedRegistryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='packproof-registry-tests-')
        cls.folder = Path(cls.directory.name)
        for name, algorithm in [('authority', 'EC'), ('signer', 'EC'), ('rsa-authority', 'RSA')]:
            command = ['openssl', 'genpkey', '-algorithm', algorithm]
            command += ['-pkeyopt', 'ec_paramgen_curve:prime256v1'] if algorithm == 'EC' else ['-pkeyopt', 'rsa_keygen_bits:2048']
            command += ['-out', str(cls.folder / (name + '.key'))]
            subprocess.run(command, check=True, capture_output=True)
            subprocess.run(['openssl', 'pkey', '-in', str(cls.folder / (name + '.key')), '-pubout',
                            '-out', str(cls.folder / (name + '.pem'))], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def setUp(self):
        self.registry = {
            'version': 1, 'domain': 'PACKPROOF_SIGNING_TRUST_REGISTRY',
            'publishedAt': '2026-09-07T00:00:00.000Z', 'nextReviewAt': '2026-10-07T00:00:00.000Z',
            'keys': [{'keyId': 'test-signer', 'algorithm': 'ECDSA_SHA_256',
                      'publicKeyPem': (self.folder / 'signer.pem').read_text(),
                      'validFrom': '2026-01-01T00:00:00Z', 'validUntil': None,
                      'status': 'ACTIVE', 'statusEffectiveAt': None, 'reason': None}],
        }

    def sign(self, raw, name='authority', signed_at=STAMP):
        algorithm = 'RSASSA_PSS_SHA_256' if name == 'rsa-authority' else 'ECDSA_SHA_256'
        command = ['openssl', 'dgst', '-sha256', '-sign', str(self.folder / (name + '.key'))]
        if algorithm == 'RSASSA_PSS_SHA_256':
            command += ['-sigopt', 'rsa_padding_mode:pss', '-sigopt', 'rsa_pss_saltlen:32']
        result = subprocess.run(command, input=raw, capture_output=True, check=True)
        return {'algorithm': algorithm, 'keyId': 'test-signer' if name == 'signer' else 'pinned-authority',
                'signatureBase64': base64.b64encode(result.stdout).decode(), 'signedAt': signed_at}

    def write_registry(self, name='authority', mutate=None):
        signed = {'registry': copy.deepcopy(self.registry),
                  'signature': self.sign(verifier.registry_canonical_bytes(self.registry), name)}
        if mutate:
            mutate(signed)
        path = self.folder / 'registry.json'
        path.write_text(json.dumps(signed), encoding='utf-8')
        return path

    def archive(self, signed_at=STAMP, corrupt_signature=False, embedded_registry=None):
        media = b'Synthetic preserved original for offline verifier tests.'
        sha = lambda data: hashlib.sha256(data).hexdigest()
        canonical = lambda value: json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()
        manifest = {'manifestVersion': 1, 'proofId': 'proof_fixture', 'evidence': [
            {'evidenceId': 'evidence_fixture', 'sha256': sha(media), 'byteSize': len(media)}]}
        raw = canonical(manifest)
        signature = self.sign(raw, 'signer', signed_at)
        if corrupt_signature:
            signature['signatureBase64'] = base64.b64encode(b'invalid signature bytes').decode()
        package = {'schema': 'packproof.proof-package.v1', 'proofId': 'proof_fixture', 'manifestId': 'manifest_fixture',
                   'canonicalJson': raw.decode(), 'canonicalManifest': manifest, 'manifestSha256': sha(raw), 'signature': signature}
        files = {'package.json': canonical(package), 'manifest.json': raw, 'media/original.bin': media,
                 'integrity/evidence.json': canonical([{'evidenceId': 'evidence_fixture', 'path': 'media/original.bin', 'status': 'INCLUDED'}]),
                 'lifecycle/stages.json': canonical([])}
        if embedded_registry:
            files['untrusted-registry.json'] = canonical(embedded_registry)
        files['integrity/hashes.json'] = canonical({name: sha(data) for name, data in files.items()})
        path = self.folder / 'proof.zip'
        with zipfile.ZipFile(path, 'w') as archive:
            for name, data in files.items():
                archive.writestr(name, data)
        return path

    def check(self, **kwargs):
        return verifier.verify(self.archive(**kwargs), now=NOW, registry_path=self.write_registry(),
                               authority_key_path=self.folder / 'authority.pem', authority_key_id='pinned-authority')

    def test_fresh_signed_registry_verifies_original_and_reports_offline_snapshot(self):
        result = self.check()
        self.assertEqual(result['status'], 'VERIFIED')
        self.assertTrue(result['signatureVerified'])
        self.assertEqual(result['evidenceVerified'], 1)
        self.assertTrue(result['signature']['keyTrustedAtSnapshot'])
        self.assertEqual(result['trust']['currentRevocationKnowledge'], 'UNAVAILABLE')
        self.assertFalse(result['trust']['networkUsed'])

    def test_rsa_pss_registry_authority_and_cli_flags(self):
        archive, registry = self.archive(), self.write_registry('rsa-authority')
        result = verifier.verify(archive, now=NOW, registry_path=registry,
                                 authority_key_path=self.folder / 'rsa-authority.pem', authority_key_id='pinned-authority')
        self.assertEqual(result['status'], 'VERIFIED')
        # The process uses the real clock; independently assert math and flag wiring even when the fixture is stale.
        process = subprocess.run(['python3', str(HERE / 'verify.py'), str(archive), '--trust-registry', str(registry),
                                  '--trust-authority-key', str(self.folder / 'rsa-authority.pem'),
                                  '--trust-authority-key-id', 'pinned-authority'], capture_output=True, text=True,
                                 env={**os.environ, 'http_proxy': 'http://127.0.0.1:1', 'https_proxy': 'http://127.0.0.1:1'})
        self.assertIn(process.returncode, (0, 2))
        self.assertTrue(json.loads(process.stdout)['signatureVerified'])

    def test_corrupt_registry_and_wrong_external_authority_are_never_trusted(self):
        archive = self.archive()
        corrupt = self.write_registry(mutate=lambda signed: signed['registry']['keys'][0].update(reason='forged'))
        for registry, authority, identity in [(corrupt, 'authority', 'pinned-authority')]:
            with self.assertRaises(verifier.VerificationError) as context:
                verifier.verify(archive, now=NOW, registry_path=registry,
                                authority_key_path=self.folder / (authority + '.pem'), authority_key_id=identity)
            self.assertEqual(context.exception.status, 'UNTRUSTED_REGISTRY')
        registry = self.write_registry()
        for authority, identity in [('signer', 'pinned-authority'), ('authority', 'another-authority'), ('authority', None)]:
            with self.subTest(authority=authority, identity=identity), self.assertRaises(verifier.VerificationError) as context:
                verifier.verify(archive, now=NOW, registry_path=registry,
                                authority_key_path=self.folder / (authority + '.pem'), authority_key_id=identity)
            self.assertEqual(context.exception.status, 'UNTRUSTED_REGISTRY')

    def test_unknown_key_ignores_archive_embedded_registry(self):
        embedded = copy.deepcopy(self.registry)
        self.registry['keys'] = []
        result = self.check(embedded_registry=embedded)
        self.assertEqual(result['status'], 'UNKNOWN_KEY')
        self.assertFalse(result['signatureVerified'])

    def test_stale_and_future_registry_never_fully_verify(self):
        for published, expires, expected in [
            ('2026-09-01T00:00:00Z', '2026-09-07T12:00:00Z', 'TRUST_STALE'),
            ('2026-09-08T00:00:00Z', '2026-09-09T00:00:00Z', 'TRUST_NOT_YET_VALID'),
        ]:
            with self.subTest(expected=expected):
                self.registry.update(publishedAt=published, nextReviewAt=expires)
                result = self.check()
                self.assertTrue(result['signatureVerified'])
                self.assertEqual(result['status'], expected)

    def test_retired_key_validity_and_future_signing_dates(self):
        key = self.registry['keys'][0]
        key.update(status='RETIRED', statusEffectiveAt='2026-09-06T00:00:00Z', validUntil='2026-09-06T00:00:00Z')
        self.assertEqual(self.check(signed_at='2026-09-05T23:59:00Z')['status'], 'VERIFIED')
        for signed_at in [STAMP, '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z']:
            with self.subTest(signed_at=signed_at):
                result = self.check(signed_at=signed_at)
                self.assertTrue(result['signatureVerified'])
                self.assertEqual(result['status'], 'KEY_OUTSIDE_VALIDITY')
        key.update(status='ACTIVE', statusEffectiveAt=None, validUntil=None)
        self.assertEqual(self.check(signed_at='2026-09-08T00:00:00Z')['status'], 'KEY_OUTSIDE_VALIDITY')

    def test_revocation_or_compromise_cannot_be_defeated_by_backdating(self):
        for status in ['REVOKED', 'COMPROMISED']:
            self.registry['keys'][0].update(status=status, statusEffectiveAt='2026-09-06T00:00:00Z', reason='Test-only incident')
            for signed_at in ['2026-08-01T00:00:00Z', STAMP]:
                with self.subTest(status=status, signed_at=signed_at):
                    result = self.check(signed_at=signed_at)
                    self.assertTrue(result['signatureVerified'])
                    self.assertFalse(result['signature']['keyTrustedAtSnapshot'])
                    self.assertEqual(result['signature']['historicalTrust'], 'REQUIRES_REVIEW')
                    self.assertEqual(result['status'], status + '_KEY')

    def test_unknown_status_and_duplicate_keys_fail_closed(self):
        for mutate in [lambda registry: registry['keys'][0].update(status='SUSPENDED'),
                       lambda registry: registry['keys'].append(copy.deepcopy(registry['keys'][0]))]:
            original = copy.deepcopy(self.registry)
            mutate(self.registry)
            with self.assertRaises(verifier.VerificationError) as context:
                self.check()
            self.assertEqual(context.exception.status, 'INVALID_TRUST_REGISTRY')
            self.registry = original

    def test_invalid_manifest_signature_is_separate_from_registry_trust(self):
        result = self.check(corrupt_signature=True)
        self.assertTrue(result['trust']['registrySignatureVerified'])
        self.assertEqual(result['status'], 'INVALID_SIGNATURE')
        self.assertFalse(result['signatureVerified'])


if __name__ == '__main__':
    unittest.main()
