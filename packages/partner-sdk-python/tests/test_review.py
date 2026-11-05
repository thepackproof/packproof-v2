import json
import unittest
from urllib.parse import urlsplit, parse_qs
from packproof import PackProofClient

class ReviewClientTests(unittest.TestCase):
    def test_ambiguous_reference_remains_unresolved(self):
        calls = []
        def transport(url, method, headers, body, timeout):
            calls.append((url, method, headers, body))
            return 200, {}, json.dumps({"outcome": "ambiguous", "automaticMatch": None}).encode()
        result = PackProofClient("https://api.example.test", "fixture", transport=transport).match_entity_reference("proof-a", "000 45/#")
        self.assertIsNone(result.data["automaticMatch"])
        self.assertEqual(parse_qs(urlsplit(calls[0][0]).query)["reference"], ["000 45/#"])

    def test_assignment_keeps_revision_key_and_reason(self):
        calls = []
        def transport(url, method, headers, body, timeout):
            calls.append((url, method, headers, body))
            return 200, {}, b'{"revision":5}'
        client = PackProofClient("https://api.example.test", "fixture", transport=transport)
        client.assign_issue("issue-a", {"membershipId": "member-a", "reason": "Review"}, revision=4, idempotency_key="assign-one")
        self.assertEqual(calls[0][2]["If-Match"], '"4"')
        self.assertEqual(calls[0][2]["Idempotency-Key"], "assign-one")
        self.assertEqual(json.loads(calls[0][3]), {"membershipId": "member-a", "reason": "Review"})
