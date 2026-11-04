from __future__ import annotations

import hashlib
import hmac
import json
import math
import random
import re
import time
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Iterator, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

RETRYABLE = {408, 429, 500, 502, 503, 504}
TERMINAL = {"succeeded", "partially_succeeded", "failed", "cancelled", "action_needed"}


@dataclass(frozen=True)
class ApiResponse:
    data: Any
    status: int
    headers: Mapping[str, str]
    request_id: str | None = None
    replayed: bool = False
    raw_body: bytes = b""


class PackProofError(Exception):
    def __init__(self, message: str, *, status: int = 0, request_id: str | None = None,
                 body: Any = None, headers: Mapping[str, str] | None = None):
        super().__init__(message)
        self.status = status
        self.request_id = request_id
        self.body = body
        self.headers = dict(headers or {})
        nested = body.get("error") if isinstance(body, dict) else None
        self.code = body.get("code", nested.get("code") if isinstance(nested, dict) else body.get("title")) if isinstance(body, dict) else None


def _text(value: str, name: str) -> str:
    if not isinstance(value, str) or not value.strip() or "\r" in value or "\n" in value:
        raise ValueError(f"{name} must be a nonempty single-line string")
    return value


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _transport(url: str, method: str, headers: dict[str, str], body: bytes | None,
               timeout: float) -> tuple[int, Mapping[str, str], bytes]:
    request = Request(url, data=body, method=method, headers=headers)
    # Never forward a service credential through a redirect.
    try:
        response = build_opener(_NoRedirect()).open(request, timeout=timeout)
    except HTTPError as error:
        response = error
    with response:
        return response.status, dict(response.headers.items()), response.read()


def _delay(retry_after: str | None, attempt: int) -> float:
    if retry_after:
        try:
            seconds = float(retry_after)
        except ValueError:
            try:
                seconds = parsedate_to_datetime(retry_after).timestamp() - time.time()
            except (ValueError, TypeError, OverflowError):
                seconds = -1
        if math.isfinite(seconds) and seconds >= 0:
            return min(30.0, seconds)
    return min(30.0, 0.5 * 2 ** attempt + random.random() * 0.25)


class PackProofClient:
    """Use only on a trusted server. Keep credentials outside browsers and source control."""

    def __init__(self, base_url: str, token: str, *, merchant_id: str | None = None,
                 delegation_id: str | None = None, timeout: float = 15, max_attempts: int = 3,
                 transport: Callable = _transport, sleep: Callable[[float], None] = time.sleep,
                 allow_insecure_localhost: bool = False):
        url = urlsplit(base_url)
        local = url.hostname in {"localhost", "127.0.0.1", "::1"}
        if not url.hostname or url.username or url.password or url.query or url.fragment or (
            url.scheme != "https" and not (allow_insecure_localhost and local and url.scheme == "http")
        ):
            raise ValueError("base_url must be an HTTPS API URL without credentials, query, or fragment")
        if isinstance(max_attempts, bool) or not isinstance(max_attempts, int) or not 1 <= max_attempts <= 5:
            raise ValueError("max_attempts must be an integer from 1 to 5")
        if isinstance(timeout, bool) or not isinstance(timeout, (float, int)) or not 0 < timeout <= 300:
            raise ValueError("timeout must be greater than zero and at most 300 seconds")
        self.base_url = base_url.rstrip("/")
        self.token = _text(token, "token")
        self.merchant_id = None if merchant_id is None else _text(merchant_id, "merchant_id")
        self.delegation_id = None if delegation_id is None else _text(delegation_id, "delegation_id")
        self.timeout = timeout
        self.max_attempts = max_attempts
        self.transport = transport
        self.sleep = sleep

    def request(self, path: str, *, method: str = "GET", body: Any = None,
                idempotency_key: str | None = None, if_match: str | None = None,
                _deadline: float | None = None) -> ApiResponse:
        if not isinstance(path, str) or not path.startswith("/") or path.startswith("//") or any(c in path for c in "\\\r\n#"):
            raise ValueError("Use an API-relative path beginning with one slash")
        method = method.upper()
        payload = None if body is None else json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        headers = {"Accept": "application/json", "Authorization": f"Bearer {self.token}"}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if self.merchant_id:
            headers["PackProof-Merchant-Id"] = self.merchant_id
        if self.delegation_id:
            headers["PackProof-Delegation-Id"] = self.delegation_id
        if idempotency_key is not None:
            headers["Idempotency-Key"] = _text(idempotency_key, "idempotency_key")
        if if_match is not None:
            headers["If-Match"] = _text(if_match, "if_match")
        attempts = self.max_attempts if method in {"GET", "HEAD"} or idempotency_key is not None else 1
        for attempt in range(attempts):
            remaining = self.timeout if _deadline is None else min(self.timeout, _deadline - time.monotonic())
            if remaining <= 0:
                raise PackProofError("Operation is still processing; retain its receipt and check again")
            try:
                status, received, raw = self.transport(self.base_url + path, method, dict(headers), payload, remaining)
            except (URLError, TimeoutError, OSError) as cause:
                if attempt + 1 < attempts:
                    self._retry_sleep(_delay(None, attempt), _deadline)
                    continue
                raise PackProofError("PackProof request did not receive a response; retry with the same idempotency key") from cause
            response_headers = {key.lower(): value for key, value in received.items()}
            try:
                data = json.loads(raw) if raw else None
            except (ValueError, UnicodeDecodeError):
                data = raw
            nested = data.get("error") if isinstance(data, dict) else None
            request_id = response_headers.get("x-request-id") or (data.get("requestId") if isinstance(data, dict) else None) or (nested.get("operationId") if isinstance(nested, dict) else None)
            if 200 <= status < 300:
                return ApiResponse(data, status, response_headers, request_id, response_headers.get("idempotency-replayed") == "true", raw)
            if status in RETRYABLE and attempt + 1 < attempts:
                self._retry_sleep(_delay(response_headers.get("retry-after"), attempt), _deadline)
                continue
            message = data.get("detail", data.get("message", nested.get("message", "PackProof request failed") if isinstance(nested, dict) else "PackProof request failed")) if isinstance(data, dict) else "PackProof request failed"
            raise PackProofError(message, status=status, request_id=request_id, body=data, headers=response_headers)
        raise AssertionError("Unreachable retry state")

    def _retry_sleep(self, delay: float, deadline: float | None):
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise PackProofError("Operation is still processing; retain its receipt and check again")
            delay = min(delay, remaining)
        self.sleep(delay)

    def create_proof(self, value: dict, *, idempotency_key: str) -> ApiResponse:
        return self.request("/v1/partner/proofs", method="POST", body=value, idempotency_key=_text(idempotency_key, "idempotency_key"))

    def get_proof(self, proof_id: str) -> ApiResponse:
        return self.request(f"/v1/partner/proofs/{_segment(proof_id)}")

    def get_record(self, proof_id: str) -> ApiResponse:
        return self.request(f"/v1/partner/proofs/{_segment(proof_id)}/record")

    def get_timeline(self, proof_id: str, *, cursor: str | None = None, limit: int = 50) -> ApiResponse:
        return self.request(_query(f"/v1/partner/proofs/{_segment(proof_id)}/timeline", cursor=cursor, limit=limit))

    def get_evidence(self, proof_id: str, *, cursor: str | None = None, limit: int = 50) -> ApiResponse:
        return self.request(_query(f"/v1/partner/proofs/{_segment(proof_id)}/evidence", cursor=cursor, limit=limit))

    def get_requirements(self, proof_id: str) -> ApiResponse:
        return self.request(f"/v1/partner/proofs/{_segment(proof_id)}/requirements")

    def update_record(self, proof_id: str, value: dict, *, revision: int, idempotency_key: str) -> ApiResponse:
        return self._record_command(proof_id, "", value, revision, idempotency_key, "PATCH")

    def close_record(self, proof_id: str, reason: str, *, revision: int, idempotency_key: str) -> ApiResponse:
        return self._record_command(proof_id, "/close", {"reason": reason}, revision, idempotency_key)

    def reopen_record(self, proof_id: str, reason: str, *, revision: int, idempotency_key: str) -> ApiResponse:
        return self._record_command(proof_id, "/reopen", {"reason": reason}, revision, idempotency_key)

    def append_amendment(self, proof_id: str, value: dict, *, revision: int, idempotency_key: str) -> ApiResponse:
        return self._record_command(proof_id, "/amendments", value, revision, idempotency_key)

    def append_entity(self, proof_id: str, value: dict, *, revision: int, idempotency_key: str) -> ApiResponse:
        return self._record_command(proof_id, "/entities", value, revision, idempotency_key)

    def link_evidence(self, proof_id: str, value: dict, *, revision: int, idempotency_key: str) -> ApiResponse:
        return self._record_command(proof_id, "/evidence-links", value, revision, idempotency_key)

    def _record_command(self, proof_id, suffix, value, revision, idempotency_key, method="POST"):
        if isinstance(revision, bool) or not isinstance(revision, int) or not 1 <= revision <= 999999999:
            raise ValueError("revision must be an integer from 1 to 999999999")
        return self.request(f"/v1/partner/proofs/{_segment(proof_id)}{suffix}", method=method, body=value,
                            idempotency_key=_text(idempotency_key, "idempotency_key"), if_match=f'"{revision}"')

    def list_proofs(self, *, after: str | None = None) -> ApiResponse:
        return self.request(_query("/v1/partner/proofs", after=after))

    def resolve_proof(self, integration_account_id: str, external_id: str) -> ApiResponse:
        return self.request(_query("/v1/partner/proofs/resolve", integrationAccountId=integration_account_id, externalId=external_id))

    def request_capture(self, proof_id: str, value: dict, *, idempotency_key: str) -> ApiResponse:
        return self.request(f"/v1/partner/proofs/{_segment(proof_id)}/capture-intents", method="POST", body=value, idempotency_key=_text(idempotency_key, "idempotency_key"))

    def list_events(self, *, after: str | None = None, limit: int = 100) -> ApiResponse:
        return self.request(_query("/v1/partner/event-stream", after=after, limit=limit))

    def list_webhooks(self) -> ApiResponse:
        return self.request("/v1/partner/webhooks")

    def create_webhook(self, value: dict, *, idempotency_key: str) -> ApiResponse:
        return self.request("/v1/partner/webhooks", method="POST", body=value, idempotency_key=_text(idempotency_key, "idempotency_key"))

    def revoke_webhook(self, webhook_id: str, *, idempotency_key: str) -> ApiResponse:
        return self.request(f"/v1/partner/webhooks/{_segment(webhook_id)}", method="DELETE", idempotency_key=_text(idempotency_key, "idempotency_key"))

    def get_limits(self) -> ApiResponse:
        return self.request('/v1/partner/limits')

    def list_issues(self, *, status: str | None = None, proof_id: str | None = None, cursor: str | None = None, limit: int = 50) -> ApiResponse:
        return self.request(_query('/v1/partner/issues', status=status, proofId=proof_id, cursor=cursor, limit=limit))

    def act_on_issue(self, issue_id: str, value: dict, *, revision: int, idempotency_key: str) -> ApiResponse:
        if isinstance(revision, bool) or not isinstance(revision, int) or not 1 <= revision <= 999999999:
            raise ValueError('revision must be an integer from 1 to 999999999')
        return self.request(f'/v1/partner/issues/{_segment(issue_id)}/actions', method='POST', body=value,
                            if_match=f'"{revision}"', idempotency_key=_text(idempotency_key, 'idempotency_key'))

    def list_connections(self, *, cursor: str | None = None, limit: int = 50) -> ApiResponse:
        return self.request(_query('/v1/partner/connections', cursor=cursor, limit=limit))

    def list_audit_events(self, *, operation: str | None = None, resource_id: str | None = None, from_time: str | None = None,
                          to_time: str | None = None, cursor: str | None = None, limit: int = 50) -> ApiResponse:
        return self.request(_query('/v1/partner/audit-events', operation=operation, resourceId=resource_id, **{'from': from_time, 'to': to_time}, cursor=cursor, limit=limit))

    def list_webhook_deliveries(self, *, state: str | None = None, webhook_id: str | None = None, cursor: str | None = None, limit: int = 50) -> ApiResponse:
        return self.request(_query('/v1/partner/webhook-deliveries', state=state, webhookId=webhook_id, cursor=cursor, limit=limit))

    def replay_webhook_delivery(self, delivery_id: str, reason: str, *, idempotency_key: str) -> ApiResponse:
        return self.request(f'/v1/partner/webhook-deliveries/{_segment(delivery_id)}/replay', method='POST', body={'reason': reason},
                            idempotency_key=_text(idempotency_key, 'idempotency_key'))

    def create_ingestion(self, value: dict, *, idempotency_key: str) -> ApiResponse:
        return self.request('/v1/partner/ingestions', method='POST', body=value, idempotency_key=_text(idempotency_key, 'idempotency_key'))

    def get_operation(self, operation_id: str) -> ApiResponse:
        return self.request(f'/v1/partner/operations/{_segment(operation_id)}')

    def wait_for_operation(self, operation_id: str, *, interval: float = 1, timeout: float = 60) -> ApiResponse:
        return self.poll_operation(f'/v1/partner/operations/{_segment(operation_id)}', interval=interval, timeout=timeout)

    def proof_ids(self, *, after: str | None = None, max_pages: int = 10000) -> Iterator[str]:
        _page_limit(max_pages)
        for _ in range(max_pages):
            data = self.list_proofs(after=after).data
            if not isinstance(data, dict) or not isinstance(data.get("proofIds"), list):
                raise PackProofError("Unexpected Proof page response", body=data)
            yield from data["proofIds"]
            if not data.get("hasMore"):
                return
            next_cursor = data.get("nextCursor")
            if not isinstance(next_cursor, str) or not next_cursor or next_cursor == after:
                raise PackProofError("Proof pagination did not advance", body=data)
            after = next_cursor
        raise PackProofError("Proof pagination exceeded max_pages; save the cursor and resume explicitly")

    def event_pages(self, *, after: str | None = None, limit: int = 100, max_pages: int = 10000) -> Iterator[ApiResponse]:
        _page_limit(max_pages)
        for _ in range(max_pages):
            result = self.list_events(after=after, limit=limit)
            yield result
            if not result.data.get("hasMore"):
                return
            next_cursor = result.data.get("nextCursor")
            if not isinstance(next_cursor, str) or not next_cursor or next_cursor == after:
                raise PackProofError("Event pagination did not advance", body=result.data)
            after = next_cursor
        raise PackProofError("Event pagination exceeded max_pages; save the cursor and resume explicitly")

    def poll_operation(self, path: str, *, interval: float = 1, timeout: float = 60) -> ApiResponse:
        if not 0 < interval <= 30 or not 0 < timeout <= 3600:
            raise ValueError("interval must be in (0, 30] and timeout in (0, 3600] seconds")
        deadline = time.monotonic() + timeout
        while True:
            result = self.request(path, _deadline=deadline)
            if isinstance(result.data, dict) and result.data.get("state") in TERMINAL:
                return result
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise PackProofError("Operation is still processing; retain its receipt and check again", body=result.data)
            self.sleep(min(interval, remaining))

    def timeline_pages(self, proof_id: str, *, cursor: str | None = None, limit: int = 50, max_pages: int = 10000) -> Iterator[ApiResponse]:
        yield from self._child_pages(self.get_timeline, proof_id, cursor=cursor, limit=limit, max_pages=max_pages)

    def evidence_pages(self, proof_id: str, *, cursor: str | None = None, limit: int = 50, max_pages: int = 10000) -> Iterator[ApiResponse]:
        yield from self._child_pages(self.get_evidence, proof_id, cursor=cursor, limit=limit, max_pages=max_pages)

    def _child_pages(self, method, proof_id: str, *, cursor: str | None, limit: int, max_pages: int) -> Iterator[ApiResponse]:
        _page_limit(max_pages)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("limit must be an integer from 1 to 100")
        for _ in range(max_pages):
            result = method(proof_id, cursor=cursor, limit=limit)
            yield result
            if not result.data.get("hasMore"):
                return
            next_cursor = result.data.get("nextCursor")
            if not isinstance(next_cursor, str) or not next_cursor or next_cursor == cursor:
                raise PackProofError("Record child pagination did not advance", body=result.data)
            cursor = next_cursor
        raise PackProofError("Record child pagination exceeded max_pages; save the cursor and resume explicitly")


def _page_limit(value: int):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 100000:
        raise ValueError("max_pages must be an integer from 1 to 100000")


def _segment(value: str) -> str:
    return quote(_text(value, "identifier"), safe="")


def _query(path: str, **values) -> str:
    query = urlencode({key: value for key, value in values.items() if value is not None})
    return path + ("?" + query if query else "")


def verify_webhook(secret: str, signature: str, raw_body: bytes | str, *, now_seconds: int | None = None,
                   tolerance_seconds: int = 300) -> bool:
    """Verify bytes before JSON parsing. Durably deduplicate authenticated event IDs separately."""
    if now_seconds is None:
        now_seconds = int(time.time())
    if not isinstance(secret, str) or not secret or not isinstance(signature, str) or not isinstance(raw_body, (str, bytes)):
        return False
    if isinstance(now_seconds, bool) or not isinstance(now_seconds, int) or isinstance(tolerance_seconds, bool) or not isinstance(tolerance_seconds, int) or tolerance_seconds < 0:
        return False
    match = re.fullmatch(r"t=(\d{1,16}),v1=([a-f0-9]{64})", signature, flags=re.ASCII)
    if not match:
        return False
    timestamp = int(match[1])
    if timestamp > 9007199254740991 or abs(now_seconds - timestamp) > tolerance_seconds:
        return False
    raw = raw_body.encode("utf-8") if isinstance(raw_body, str) else raw_body
    expected = hmac.new(secret.encode("utf-8"), str(timestamp).encode("ascii") + b"." + raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, match[2])
