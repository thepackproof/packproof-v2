import base64
import subprocess
import unittest
from unittest.mock import patch
from verify import check_signature


class SignatureExecutionTests(unittest.TestCase):
    def check(self, outcome):
        signature = {'algorithm': 'ECDSA_SHA_256', 'keyId': 'test-key',
                     'signatureBase64': base64.b64encode(b'signature').decode()}
        keys = {'test-key': {'algorithm': 'ECDSA_SHA_256', 'status': 'ACTIVE',
                             'publicKeyPem': 'public test placeholder'}}
        with patch('verify.shutil.which', return_value='openssl'), patch('verify.subprocess.run') as run:
            if isinstance(outcome, BaseException):
                run.side_effect = outcome
            else:
                run.return_value = subprocess.CompletedProcess([], outcome)
            return check_signature(b'manifest', signature, keys)

    def test_environment_failure_is_unchecked(self):
        for outcome in (3221225794, -9, OSError('unavailable'), subprocess.TimeoutExpired('openssl', 10)):
            with self.subTest(outcome=type(outcome).__name__):
                result = self.check(outcome)
                self.assertEqual(result['status'], 'SIGNATURE_UNCHECKED')
                self.assertFalse(result['verified'])

    def test_mathematical_results_remain_distinct(self):
        self.assertEqual(self.check(1)['status'], 'INVALID_SIGNATURE')
        self.assertEqual(self.check(0)['status'], 'VERIFIED')


if __name__ == '__main__':
    unittest.main()
