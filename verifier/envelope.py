"""Independent Python verifier for the additive JCS/ES256 profile; no AWS or network.

Uses rfc8785 and cryptography, not the TypeScript signer or its DER converter.
The caller has already bounded and validated ZIP entries. Trust is a separate,
operator-authenticated file; archive-included keys are never used.
"""
import base64
import datetime as dt
import hashlib
import json
import re
from pathlib import Path

PROFILE = 'packproof.integrity-envelope.v1'
COVERAGE = 'packproof.integrity-coverage.v1'
PACKAGE = 'packproof.signed-proof-package.v2'
TYPE = 'application/packproof-integrity+jws'

def check(ok, message):
    if not ok:
        raise ValueError(message)

def exact(value, fields):
    check(isinstance(value, dict) and set(value) == set(fields.split()), 'Unexpected profile fields')

def stamp(value):
    check(isinstance(value, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', value), 'Invalid timestamp')
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00'))

def identifier(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_:/.-]{1,200}', value) is not None

def sha(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None

def safe_path(value):
    return isinstance(value, str) and len(value) <= 1024 and re.fullmatch(r'[A-Za-z0-9_./-]+', value) is not None and all(p not in ('', '.', '..') for p in value.split('/'))

def b64(value, maximum):
    check(isinstance(value, str) and 0 < len(value) <= maximum and re.fullmatch('[A-Za-z0-9_-]+', value), 'Invalid base64url')
    decoded = base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))
    check(base64.urlsafe_b64encode(decoded).decode().rstrip('=') == value, 'Noncanonical base64url')
    return decoded

def json_value(data):
    def pairs(items):
        result = {}
        for key, value in items:
            check(key not in result, 'Duplicate JSON member')
            result[key] = value
        return result
    def invalid(_):
        raise ValueError('Non-finite JSON value')
    return json.loads(data.decode('utf-8'), object_pairs_hook=pairs, parse_constant=invalid)

def verify_package(package, names, read, trust_path, now, expected_proof=None, expected_digest=None):
    import rfc8785
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec, utils

    exact(package, 'schema proofId envelopePath coveragePath timestamp')
    check(package['schema'] == PACKAGE and identifier(package['proofId']) and package['envelopePath'] == 'integrity/envelope.jws.json' and package['coveragePath'] == 'integrity/coverage.json', 'Invalid package profile')
    exact(package['timestamp'], 'state')
    check(package['timestamp']['state'] in ('NOT_PRESENT', 'PENDING'), 'Unvalidated timestamp assertion')
    jws_bytes = read(package['envelopePath'])
    check(len(jws_bytes) <= 40000, 'JWS size limit exceeded')
    jws = json_value(jws_bytes)
    exact(jws, 'protected payload signature')
    header_bytes = b64(jws['protected'], 4096)
    header = json_value(header_bytes)
    exact(header, 'alg kid typ')
    check(header['alg'] == 'ES256' and identifier(header['kid']) and header['typ'] == TYPE and rfc8785.dumps(header) == header_bytes, 'Unsupported or noncanonical JWS header')
    payload_bytes = b64(jws['payload'], 24000)
    envelope = json_value(payload_bytes)
    exact(envelope, 'profile proofId recordType recordId manifestSchema manifestPath manifestSha256 coverageSha256 issuer issuedAt')
    check(envelope['profile'] == PROFILE and all(identifier(envelope[k]) for k in ('proofId', 'recordId', 'manifestSchema')) and envelope['recordType'] in ('CORE', 'STAGE', 'SUPPLEMENT') and safe_path(envelope['manifestPath']) and sha(envelope['manifestSha256']) and sha(envelope['coverageSha256']), 'Invalid envelope')
    check(isinstance(envelope['issuer'], str) and len(envelope['issuer']) <= 300 and re.fullmatch(r'https://[A-Za-z0-9.-]+(?:/[A-Za-z0-9_./-]*)?', envelope['issuer']), 'Invalid issuer')
    issued = stamp(envelope['issuedAt'])
    check(issued <= now and rfc8785.dumps(envelope) == payload_bytes, 'Future or noncanonical envelope')
    check(envelope['proofId'] == package['proofId'] and (not expected_proof or envelope['proofId'] == expected_proof) and (not expected_digest or envelope['manifestSha256'] == expected_digest.lower()), 'Required record identity mismatch')
    signature = b64(jws['signature'], 100)
    check(len(signature) == 64, 'ES256 signature must be 64 bytes')

    coverage_bytes = read(package['coveragePath'])
    check(len(coverage_bytes) <= 8 * 1024 * 1024 and hashlib.sha256(coverage_bytes).hexdigest() == envelope['coverageSha256'], 'Altered coverage manifest')
    coverage = json_value(coverage_bytes)
    exact(coverage, 'profile proofId recordType recordId artifacts stages omissions')
    check(coverage['profile'] == COVERAGE and all(coverage[k] == envelope[k] for k in ('proofId', 'recordType', 'recordId')) and rfc8785.dumps(coverage) == coverage_bytes, 'Coverage binding mismatch')
    check(isinstance(coverage['artifacts'], list) and 0 < len(coverage['artifacts']) <= 4000 and isinstance(coverage['stages'], list) and len(coverage['stages']) <= 1000 and isinstance(coverage['omissions'], list) and len(coverage['omissions']) <= 4000, 'Invalid coverage size')
    artifacts, files, missing, modified = {}, [], [], []
    reserved = {'package.json', package['envelopePath'], package['coveragePath']}
    for item in coverage['artifacts']:
        exact(item, 'path kind sha256 byteSize required storage sourcePath')
        path = item['path']
        check(safe_path(path) and path not in artifacts and path not in reserved, 'Duplicate or unsafe artifact path')
        check(item['kind'] in ('MANIFEST', 'ORIGINAL', 'DERIVATIVE') and sha(item['sha256']) and type(item['byteSize']) is int and 0 <= item['byteSize'] <= 9007199254740991 and type(item['required']) is bool, 'Invalid artifact')
        exact(item['storage'], 'bucket key versionId')
        check(all(isinstance(item['storage'][k], str) and 0 < len(item['storage'][k]) <= maximum and not re.search(r'[\x00-\x1f\ud800-\udfff]', item['storage'][k]) for k, maximum in [('bucket', 63), ('key', 1024), ('versionId', 1024)]) and item['storage']['versionId'] != 'null', 'Exact object version required')
        check(safe_path(item['sourcePath']) if item['kind'] == 'DERIVATIVE' else item['sourcePath'] is None, 'Invalid source relationship')
        artifacts[path] = item
        if path not in names:
            missing.append(path)
            files.append({'path': path, 'status': 'MISSING', 'sha256': item['sha256']})
            continue
        data = read(path)
        matched = len(data) == item['byteSize'] and hashlib.sha256(data).hexdigest() == item['sha256']
        if not matched:
            modified.append(path)
        files.append({'path': path, 'status': 'HASH_MATCHED' if matched else 'HASH_MISMATCH', 'sha256': item['sha256']})
    check(not (set(names) - reserved - set(artifacts)), 'Uncovered archive entries')
    for item in artifacts.values():
        if item['kind'] == 'DERIVATIVE':
            check(artifacts.get(item['sourcePath'], {}).get('kind') == 'ORIGINAL', 'Missing original-source commitment')
    root = artifacts.get(envelope['manifestPath'], {})
    check(root.get('kind') == 'MANIFEST' and root.get('required') is True and root.get('sha256') == envelope['manifestSha256'], 'Frozen manifest commitment missing')
    stage_ids, stage_paths = set(), set()
    for stage in coverage['stages']:
        exact(stage, 'stageId manifestPath manifestSha256')
        item = artifacts.get(stage['manifestPath'], {})
        check(identifier(stage['stageId']) and stage['stageId'] not in stage_ids and stage['manifestPath'] not in stage_paths and item.get('kind') == 'MANIFEST' and item.get('required') is True and item.get('sha256') == stage['manifestSha256'], 'Substituted stage commitment')
        stage_ids.add(stage['stageId']); stage_paths.add(stage['manifestPath'])
    omission_paths = set()
    for omission in coverage['omissions']:
        exact(omission, 'path reason')
        check(safe_path(omission['path']) and omission['path'] not in omission_paths and isinstance(omission['reason'], str) and 0 < len(omission['reason']) <= 500, 'Invalid omission')
        omission_paths.add(omission['path'])

    key, current, trusted_at_issue, trust = None, False, False, {'status': 'UNAVAILABLE'}
    if trust_path:
        check(Path(trust_path).stat().st_size <= 1024 * 1024, 'Trust file exceeds limit')
        registry = json_value(Path(trust_path).read_bytes())
        exact(registry, 'schema issuer publishedAt nextReviewAt keys')
        check(registry['schema'] == 'packproof.envelope-trust.v1' and isinstance(registry['issuer'], str) and isinstance(registry['keys'], list) and len(registry['keys']) <= 100, 'Invalid independent trust')
        published, expires = stamp(registry['publishedAt']), stamp(registry['nextReviewAt'])
        check(published <= now and expires > published, 'Invalid trust validity window')
        seen = set()
        for candidate in registry['keys']:
            exact(candidate, 'keyId publicKeyPem status validFrom validUntil statusEffectiveAt')
            check(identifier(candidate['keyId']) and candidate['keyId'] not in seen and candidate['status'] in ('ACTIVE', 'RETIRED', 'REVOKED', 'COMPROMISED'), 'Invalid trust key identity')
            seen.add(candidate['keyId'])
            start = stamp(candidate['validFrom'])
            end = stamp(candidate['validUntil']) if candidate['validUntil'] is not None else None
            effective = stamp(candidate['statusEffectiveAt']) if candidate['statusEffectiveAt'] is not None else None
            check(end is None or end >= start, 'Invalid key validity')
            check(effective is None if candidate['status'] == 'ACTIVE' else effective is not None and start <= effective <= published, 'Invalid key status date')
            pem = candidate['publicKeyPem']
            check(isinstance(pem, str) and 0 < len(pem) <= 32768 and 'PRIVATE' not in pem, 'Public key required')
            public = serialization.load_pem_public_key(pem.encode('ascii'))
            check(isinstance(public, ec.EllipticCurvePublicKey) and isinstance(public.curve, ec.SECP256R1), 'P-256 key required')
            if candidate['keyId'] == header['kid'] and registry['issuer'] == envelope['issuer']:
                key = (candidate, public)
                trusted_at_issue = start <= issued and (end is None or issued <= end) and (candidate['status'] == 'ACTIVE' or candidate['status'] == 'RETIRED' and issued <= effective)
        current = now < expires
        trust = {'status': 'CURRENT_SNAPSHOT' if current else 'STALE_SNAPSHOT', 'publishedAt': registry['publishedAt'], 'expiresAt': registry['nextReviewAt'], 'currentRevocationKnowledge': 'UNAVAILABLE_OFFLINE'}

    issuer_signature = 'UNKNOWN_KEY'
    if key:
        try:
            # cryptography handles ASN.1 encoding; no handwritten DER conversion.
            der = utils.encode_dss_signature(int.from_bytes(signature[:32], 'big'), int.from_bytes(signature[32:], 'big'))
            key[1].verify(der, (jws['protected'] + '.' + jws['payload']).encode('ascii'), ec.ECDSA(hashes.SHA256()))
            issuer_signature = 'VALID'
        except InvalidSignature:
            issuer_signature = 'INVALID'
    partial = bool(missing or coverage['omissions'])
    hash_integrity = 'FAIL' if modified else 'INCOMPLETE' if missing else 'PASS'
    coverage_state = 'UNKNOWN' if issuer_signature != 'VALID' else 'PARTIAL' if partial or modified else 'COMPLETE_FOR_DECLARED_SCOPE'
    verified = hash_integrity == 'PASS' and issuer_signature == 'VALID' and coverage_state == 'COMPLETE_FOR_DECLARED_SCOPE' and current and trusted_at_issue
    return {'status': 'VERIFIED' if verified else 'INTEGRITY_INCOMPLETE', 'proofId': envelope['proofId'], 'manifestSha256': envelope['manifestSha256'], 'profile': PROFILE,
            'hashIntegrity': hash_integrity, 'issuerSignature': issuer_signature, 'timestamp': package['timestamp']['state'], 'coverage': coverage_state,
            'keyStatus': key[0]['status'] if key else 'UNKNOWN', 'truthOfRecordedScene': 'NOT_ASSESSED', 'signatureVerified': issuer_signature == 'VALID',
            'keyTrustedAtIssue': trusted_at_issue, 'trust': trust, 'files': files, 'missing': missing, 'modified': modified, 'omissions': coverage['omissions'],
            'evidenceVerified': sum(a['kind'] == 'ORIGINAL' and p not in missing and p not in modified for p, a in artifacts.items()),
            'limitations': ['Coverage is limited to the signed declaration; unseen later stages are not ruled out.', 'Storage identities are signed commitments, not a live storage-retention audit.', 'Issuer time is not capture time or an RFC 3161 timestamp.', 'Archive keys never establish trust; offline revocation freshness is unavailable.', 'Integrity does not establish the truth of the recorded scene.']}
