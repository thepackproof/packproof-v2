import hashlib
import hmac
import json
import sys
import unittest
from pathlib import Path
from urllib.error import URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from packproof import PackProofClient, PackProofError, verify_webhook


def response(value, status=200, **headers):
    return status, headers, json.dumps(value).encode()


class ClientTests(unittest.TestCase):
    def test_resume_skips_accepted_parts_and_retries_identical_bytes(self):
        data = b'\x01\x02\x03'
        value = {'proofId':'proof','connectionId':'source','filename':'a.png','contentType':'image/png','byteSize':3,'reportedAt':'2026-11-04T12:00:00Z'}
        calls, progress = [], []
        writes = 0
        def transport(url, method, headers, body, timeout):
            nonlocal writes
            calls.append((url, method, headers, body))
            if url.endswith('/upload-sessions/session'):
                return response({**value,'sessionId':'session','artifactId':'artifact','state':'open','partSize':2,'expectedSha256':hashlib.sha256(data).hexdigest(),'receivedParts':[{'partNumber':1,'byteSize':2,'sha256':hashlib.sha256(data[:2]).hexdigest()}]})
            if url.endswith('/parts/2'):
                writes += 1
                self.assertEqual(body, data[2:])
                self.assertEqual(headers['Content-Length'], '1')
                self.assertEqual(headers['Content-Type'], 'image/png')
                if writes == 1:
                    raise URLError('lost acknowledgement')
                return response({'partNumber':2})
            if url.endswith('/parts/complete'):
                return response({'state':'received'})
            return response({'operationId':'source_completion_1','state':'queued'}, 202)
        result = self.client(transport).upload_artifact(value, data, idempotency_key='one', resume_session_id='session', on_progress=progress.append)
        self.assertEqual(result.data['state'], 'queued')
        self.assertEqual(writes, 2)
        self.assertFalse(any(url.endswith('/parts/1') for url, *_ in calls))
        self.assertEqual([p['acceptedBytes'] for p in progress], [2, 3])

    def test_resume_rejects_changed_accepted_parts_without_writing(self):
        value = {'proofId':'proof','connectionId':'source','filename':'a.png','contentType':'image/png','byteSize':1,'reportedAt':'2026-11-04T12:00:00Z'}
        calls = []
        def transport(*args):
            calls.append(args)
            return response({**value,'sessionId':'session','artifactId':'artifact','state':'open','partSize':2,'receivedParts':[{'partNumber':1,'byteSize':1,'sha256':'a'*64}]})
        with self.assertRaisesRegex(PackProofError, 'accepted part belongs to different bytes'):
            self.client(transport).upload_artifact(value, b'\x07', idempotency_key='one', resume_session_id='session')
        self.assertEqual(len(calls), 1)

    def test_binary_package_bytes_remain_exact(self):
        data = b'PK\x03\x04\x00\xff'
        result = self.client(lambda *args: (200, {'X-Request-Id':'binary'}, data)).download_export('one')
        self.assertEqual(result.data, data)
        self.assertEqual(result.raw_body, data)
        self.assertEqual(result.request_id, 'binary')

    def client(self, transport, **options):
        return PackProofClient("https://api.example.test", "test_secret", merchant_id="merchant_1", delegation_id="grant_1", transport=transport, sleep=lambda _: None, **options)

    def test_lost_response_retries_same_payload_and_key(self):
        calls = []
        def transport(*args):
            calls.append(args)
            if len(calls) == 1:
                raise URLError("lost response")
            return response({"proofId": "pr_1", "created": True}, 201, **{"X-Request-Id": "req_2", "Idempotency-Replayed": "true"})
        result = self.client(transport).create_proof({"externalId": "00001"}, idempotency_key="source_1:00001:v1")
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][3], calls[1][3])
        self.assertEqual(calls[1][2]["Idempotency-Key"], "source_1:00001:v1")
        self.assertEqual(calls[1][2]["PackProof-Merchant-Id"], "merchant_1")
        self.assertEqual(calls[1][2]["PackProof-Delegation-Id"], "grant_1")
        self.assertTrue(result.replayed)
        self.assertEqual(result.request_id, "req_2")

    def test_unsafe_command_without_key_is_not_retried(self):
        calls = []
        client = self.client(lambda *args: calls.append(args) or response({"detail": "busy"}, 503))
        with self.assertRaises(PackProofError):
            client.request("/v1/partner/proofs", method="POST", body={})
        self.assertEqual(len(calls), 1)
        with self.assertRaises(ValueError):
            client.create_proof({}, idempotency_key="")

    def test_retry_and_error_details(self):
        calls, delays = [], []
        client = self.client(lambda *args: calls.append(args) or (response({}, 429, **{"Retry-After": "999999"}) if len(calls) == 1 else response({"proofIds": []})))
        client.sleep = delays.append
        client.list_proofs()
        self.assertEqual(delays, [30.0])
        for status in (401, 403, 409, 410, 412):
            calls.clear()
            client.transport = lambda *args: calls.append(args) or response({"code": "SAFE_ERROR", "detail": "Refresh current state"}, status, **{"X-Request-Id": "req_1"})
            with self.assertRaises(PackProofError) as captured:
                client.get_proof("pr_1")
            self.assertEqual(captured.exception.status, status)
            self.assertEqual(captured.exception.request_id, "req_1")
            self.assertEqual(captured.exception.code, "SAFE_ERROR")
            self.assertEqual(len(calls), 1)
        client.transport = lambda *args: response({'error': {'code': 'INVALID_JSON', 'message': 'Request body must be valid JSON', 'operationId': 'op_legacy', 'retryable': False}}, 400)
        with self.assertRaises(PackProofError) as captured:
            client.get_proof('pr_1')
        self.assertEqual(captured.exception.code, 'INVALID_JSON')
        self.assertEqual(captured.exception.request_id, 'op_legacy')
        self.assertEqual(str(captured.exception), 'Request body must be valid JSON')

    def test_opaque_cursor_iteration_and_no_infinite_cursor(self):
        calls = []
        def transport(*args):
            calls.append(args)
            return response({"proofIds": [f"pr_{len(calls)}"], "nextCursor": "scope.bound+cursor", "hasMore": len(calls) == 1})
        client = self.client(transport)
        self.assertEqual(list(client.proof_ids()), ["pr_1", "pr_2"])
        self.assertIn("after=scope.bound%2Bcursor", calls[1][0])
        client.transport = lambda *args: response({"proofIds": [], "nextCursor": "same", "hasMore": True})
        with self.assertRaisesRegex(PackProofError, "did not advance"):
            list(client.proof_ids(after="same"))

    def test_requests_cannot_redirect_credentials_to_another_origin(self):
        client = self.client(lambda *args: response({}))
        for path in ("//evil.test/steal", "https://evil.test/steal", "/\\evil.test/steal"):
            with self.assertRaises(ValueError):
                client.request(path)
        with self.assertRaises(ValueError):
            PackProofClient("http://api.example.test", "key")

    def test_poll_preserves_partial_outcome(self):
        states = iter(["running", "partially_succeeded"])
        client = self.client(lambda *args: response({"state": next(states), "rows": [{"state": "failed"}]}))
        result = client.poll_operation("/v1/partner/operations/op_1")
        self.assertEqual(result.data["state"], "partially_succeeded")
        self.assertEqual(result.data["rows"][0]["state"], "failed")

    def test_record_mutation_preserves_revision_and_actionable_poll_result(self):
        calls = []
        client = self.client(lambda *args: calls.append(args) or response({"proofId": "pr_1", "revision": 8}))
        result = client.update_record("pr_1", {"reference": "SHIP-0001", "reason": "Correct source mapping"}, revision=7, idempotency_key="correction_1")
        self.assertEqual(calls[0][1], "PATCH")
        self.assertEqual(calls[0][2]["If-Match"], '"7"')
        self.assertEqual(calls[0][2]["Idempotency-Key"], "correction_1")
        self.assertEqual(result.data["revision"], 8)
        with self.assertRaises(ValueError):
            client.close_record("pr_1", "Reviewed", revision=0, idempotency_key="close_1")
        client.transport = lambda *args: response({"state": "action_needed", "lastErrorCode": "IMPORT_ORIGINAL_INTEGRITY_FAILED"})
        self.assertEqual(client.poll_operation("/me/records/imports/import_1").data["state"], "action_needed")

    def test_record_child_iteration_keeps_scoped_cursor_and_size(self):
        calls = []
        def transport(*args):
            calls.append(args)
            return response({"evidence": [{"id": f"e_{len(calls)}"}], "nextCursor": "scoped+child" if len(calls) == 1 else None, "hasMore": len(calls) == 1})
        client = self.client(transport)
        ids = [item['id'] for page in client.evidence_pages('pr/1', limit=1) for item in page.data['evidence']]
        self.assertEqual(ids, ['e_1', 'e_2'])
        self.assertIn('cursor=scoped%2Bchild', calls[1][0])
        self.assertIn('limit=1', calls[1][0])
        self.assertIn('pr%2F1/evidence', calls[1][0])

    def test_webhook_exact_bytes_and_freshness(self):
        secret, timestamp = "whsec_test", 1793811600
        raw = '{ "id":"evt_1", "message":"café" }'.encode()
        digest = hmac.new(secret.encode(), str(timestamp).encode() + b"." + raw, hashlib.sha256).hexdigest()
        signature = f"t={timestamp},v1={digest}"
        self.assertTrue(verify_webhook(secret, signature, raw, now_seconds=timestamp))
        self.assertFalse(verify_webhook(secret, signature, json.dumps(json.loads(raw)), now_seconds=timestamp))
        self.assertFalse(verify_webhook(secret, signature, raw + b" ", now_seconds=timestamp))
        self.assertFalse(verify_webhook(secret, signature, raw, now_seconds=timestamp + 301))
        self.assertFalse(verify_webhook(secret, signature, raw, now_seconds=timestamp - 301))
        self.assertFalse(verify_webhook(secret, signature + ",v1=bad", raw, now_seconds=timestamp))
        self.assertFalse(verify_webhook(secret, "t=NaN,v1=00", raw, now_seconds=timestamp))


if __name__ == "__main__":
    unittest.main()
