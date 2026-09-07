#!/usr/bin/env python3
"""PackProof independent offline ZIP verifier v1.2.0 (Python 3.10+, OpenSSL for signatures).
Never extracts archive entries, executes package content, or opens network connections.
Trust lists must be obtained and authenticated separately from the package.
"""
import argparse
import base64
import binascii
import datetime as dt
import hashlib
import html
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile

VERSION = '1.2.0'
MAX_BYTES = 220 * 1024 * 1024
MAX_JSON = 8 * 1024 * 1024
MAX_ENTRIES = 4096
ALGORITHMS = {'ECDSA_SHA_256', 'RSASSA_PSS_SHA_256'}

class VerificationError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)

def fail(status, message):
    raise VerificationError(status, message)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail('INVALID_PACKAGE', 'Duplicate JSON member: ' + key)
        result[key] = value
    return result

def json_bytes(data):
    try:
        return json.loads(data.decode('utf-8'), object_pairs_hook=no_duplicates,
                          parse_constant=lambda _: fail('INVALID_PACKAGE', 'Non-finite JSON number'))
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        fail('INVALID_PACKAGE', 'Malformed UTF-8 JSON')

def safe_name(name):
    return (isinstance(name, str) and len(name.encode('utf-8')) <= 1024
            and re.fullmatch(r'[A-Za-z0-9_./-]+', name) is not None
            and not name.startswith('/') and all(p not in ('', '.', '..') for p in name.split('/')))

def date(value, error_status='INVALID_TRUST_LIST'):
    if not isinstance(value, str):
        fail(error_status, 'Trust timestamps must be ISO 8601 strings')
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed
    except ValueError:
        fail(error_status, 'Trust timestamp must include a timezone')

def registry_canonical_bytes(registry):
    # The closed registry schema has ASCII member names and only string/null values,
    # arrays, and the integer version 1. Python and sorted-json.v1 agree for this subset.
    try:
        return json.dumps(registry, sort_keys=True, ensure_ascii=False,
                          separators=(',', ':'), allow_nan=False).encode('utf-8')
    except (UnicodeError, ValueError, TypeError):
        fail('INVALID_TRUST_REGISTRY', 'Registry contains unsupported text or values')

def load_registry(path, authority_path, authority_id, now):
    if not authority_path or not isinstance(authority_id, str) or not authority_id.strip():
        fail('UNTRUSTED_REGISTRY', 'An independently pinned authority PEM and authority key ID are required')
    if os.path.getsize(path) > MAX_JSON or os.path.getsize(authority_path) > 65536:
        fail('INVALID_TRUST_REGISTRY', 'Registry or authority key exceeds its size limit')
    try:
        signed = json_bytes(Path(path).read_bytes())
        authority = Path(authority_path).read_text(encoding='utf-8')
    except VerificationError:
        fail('INVALID_TRUST_REGISTRY', 'Malformed signed registry JSON')
    if (not isinstance(signed, dict) or set(signed) != {'registry', 'signature'}
            or not isinstance(signed['registry'], dict) or not isinstance(signed['signature'], dict)):
        fail('INVALID_TRUST_REGISTRY', 'Expected a signed registry envelope')
    registry, signature = signed['registry'], signed['signature']
    if (set(registry) != {'version', 'domain', 'publishedAt', 'nextReviewAt', 'keys'}
            or type(registry['version']) is not int or registry['version'] != 1
            or registry['domain'] != 'PACKPROOF_SIGNING_TRUST_REGISTRY'
            or not isinstance(registry['keys'], list) or len(registry['keys']) > 4096):
        fail('INVALID_TRUST_REGISTRY', 'Unsupported signing registry schema')
    generated = date(registry['publishedAt'], 'INVALID_TRUST_REGISTRY')
    expires = date(registry['nextReviewAt'], 'INVALID_TRUST_REGISTRY')
    if expires <= generated:
        fail('INVALID_TRUST_REGISTRY', 'Registry review deadline must follow publication')
    keys = {}
    for key in registry['keys']:
        if (not isinstance(key, dict) or set(key) != {'keyId', 'algorithm', 'publicKeyPem', 'validFrom', 'validUntil', 'status', 'statusEffectiveAt', 'reason'}
                or not isinstance(key['keyId'], str) or not 1 <= len(key['keyId']) <= 200
                or key['keyId'] in keys or key['algorithm'] not in ALGORITHMS
                or key['status'] not in ('ACTIVE', 'RETIRED', 'REVOKED', 'COMPROMISED')
                or not isinstance(key['publicKeyPem'], str) or not 1 <= len(key['publicKeyPem']) <= 65536
                or (key['reason'] is not None and not isinstance(key['reason'], str))):
            fail('INVALID_TRUST_REGISTRY', 'Invalid, duplicate, or unknown-status registry key')
        start = date(key['validFrom'], 'INVALID_TRUST_REGISTRY')
        end = date(key['validUntil'], 'INVALID_TRUST_REGISTRY') if key['validUntil'] is not None else None
        effective = date(key['statusEffectiveAt'], 'INVALID_TRUST_REGISTRY') if key['statusEffectiveAt'] is not None else None
        if ((end is not None and end < start) or (effective is not None and effective > generated)
                or (key['status'] != 'ACTIVE' and effective is None)):
            fail('INVALID_TRUST_REGISTRY', 'Registry key dates are inconsistent')
        keys[key['keyId']] = key
    if (set(signature) != {'algorithm', 'keyId', 'signatureBase64', 'signedAt'}
            or signature.get('keyId') != authority_id or signature.get('algorithm') not in ALGORITHMS):
        fail('UNTRUSTED_REGISTRY', 'Registry signature does not match the independently pinned authority identity')
    date(signature['signedAt'], 'INVALID_TRUST_REGISTRY')
    authority_check = check_signature(registry_canonical_bytes(registry), signature, {
        authority_id: {'status': 'ACTIVE', 'algorithm': signature['algorithm'], 'publicKeyPem': authority}
    })
    if not authority_check['verified']:
        fail('SIGNATURE_UNCHECKED' if authority_check['status'] == 'SIGNATURE_UNCHECKED' else 'UNTRUSTED_REGISTRY',
             'The registry signature could not be verified with the independently pinned authority')
    freshness = 'NOT_YET_VALID' if generated > now else 'STALE' if expires <= now else 'FRESH'
    return keys, {'source': 'SIGNED_REGISTRY', 'status': freshness,
                  'registrySignatureVerified': True, 'authorityKeyId': authority_id,
                  'generatedAt': registry['publishedAt'], 'expiresAt': registry['nextReviewAt'],
                  'networkUsed': False, 'currentRevocationKnowledge': 'UNAVAILABLE',
                  'limitation': 'Authenticated registry snapshot only. Later revocations cannot be discovered offline.'}

def load_trust(path, now):
    if path is None:
        return {}, {'status': 'NOT_PROVIDED', 'networkUsed': False,
                    'limitation': 'Later key revocations cannot be discovered offline.'}
    if os.path.getsize(path) > MAX_JSON:
        fail('INVALID_TRUST_LIST', 'Trust list exceeds size limit')
    trust = json_bytes(Path(path).read_bytes())
    if trust.get('schema') != 'packproof.trust-list.v1':
        fail('INVALID_TRUST_LIST', 'Unsupported trust-list schema')
    generated, expires = date(trust.get('generatedAt')), date(trust.get('expiresAt'))
    if expires <= generated:
        fail('INVALID_TRUST_LIST', 'Trust expiry must follow issuance')
    keys = {}
    for key in trust.get('keys', []):
        if (not isinstance(key, dict) or not isinstance(key.get('keyId'), str)
                or key['keyId'] in keys or key.get('algorithm') not in ALGORITHMS
                or key.get('status') not in ('ACTIVE', 'REVOKED')
                or not isinstance(key.get('publicKeyPem'), str)):
            fail('INVALID_TRUST_LIST', 'Invalid or duplicate trust key')
        keys[key['keyId']] = key
    freshness = ('NOT_YET_VALID' if generated > now else 'STALE' if expires <= now else 'FRESH')
    return keys, {'status': freshness, 'generatedAt': trust['generatedAt'],
                  'expiresAt': trust['expiresAt'], 'networkUsed': False,
                  'limitation': 'No online revocation check was performed. Trust depends on how this list was obtained.'}

def check_signature(raw, signature, keys):
    if signature is None:
        return {'status': 'UNSIGNED', 'verified': False, 'keyId': None}
    if not isinstance(signature, dict) or signature.get('algorithm') not in ALGORITHMS:
        return {'status': 'UNSUPPORTED_ALGORITHM', 'verified': False, 'keyId': None}
    key_id = signature.get('keyId')
    key = keys.get(key_id)
    if key is None:
        return {'status': 'UNKNOWN_KEY', 'verified': False, 'keyId': key_id}
    if key['status'] == 'REVOKED':
        return {'status': 'REVOKED_KEY', 'verified': False, 'keyId': key_id}
    if key['algorithm'] != signature['algorithm']:
        return {'status': 'INVALID_SIGNATURE', 'verified': False, 'keyId': key_id}
    executable = shutil.which('openssl')
    if executable is None:
        return {'status': 'SIGNATURE_UNCHECKED', 'verified': False, 'keyId': key_id,
                'detail': 'OpenSSL is required for signature verification.'}
    try:
        encoded = signature.get('signatureBase64', '')
        if not isinstance(encoded, str) or len(encoded) > 16384:
            raise ValueError()
        signature_bytes = base64.b64decode(encoded, validate=True)
        with tempfile.TemporaryDirectory(prefix='packproof-verify-') as temporary:
            folder = Path(temporary)
            # Only independently supplied public key and opaque bytes are written.
            (folder / 'key.pem').write_text(key['publicKeyPem'], encoding='utf-8')
            (folder / 'signature.bin').write_bytes(signature_bytes)
            (folder / 'manifest.bin').write_bytes(raw)
            command = [executable, 'dgst', '-sha256', '-verify', str(folder / 'key.pem'),
                       '-signature', str(folder / 'signature.bin')]
            if signature['algorithm'] == 'RSASSA_PSS_SHA_256':
                command += ['-sigopt', 'rsa_padding_mode:pss', '-sigopt', 'rsa_pss_saltlen:32']
            command += [str(folder / 'manifest.bin')]
            process = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, timeout=10,
                                     env={k: v for k, v in os.environ.items()
                                          if k not in ('OPENSSL_CONF', 'OPENSSL_MODULES', 'OPENSSL_ENGINES')})
            valid = process.returncode == 0
    except (ValueError, binascii.Error, OSError, subprocess.SubprocessError):
        valid = False
    return {'status': 'VERIFIED' if valid else 'INVALID_SIGNATURE', 'verified': valid, 'keyId': key_id,
            'algorithm': signature['algorithm'], 'signedAt': signature.get('signedAt'),
            'timeMeaning': 'Reported signing time is not independently timestamped filming time.'}

def check_registry_signature(raw, signature, keys, now):
    # Preserve the mathematical result even when policy no longer trusts the key.
    crypto_keys = {identity: {**key, 'status': 'ACTIVE'} for identity, key in keys.items()}
    result = check_signature(raw, signature, crypto_keys)
    key = keys.get(result['keyId'])
    result.update({'keyStatus': key['status'] if key else 'UNKNOWN', 'keyTrustedAtSnapshot': False,
                   'historicalTrust': 'UNKNOWN_KEY' if not key else 'REQUIRES_REVIEW'})
    if not key or not result['verified']:
        return result
    result.update({name: key[name] for name in ('validFrom', 'validUntil', 'statusEffectiveAt', 'reason')})
    if key['status'] in ('REVOKED', 'COMPROMISED'):
        result['status'] = key['status'] + '_KEY'
        result['timeMeaning'] = 'A self-asserted historical signing time cannot defeat revocation or compromise.'
        return result
    try:
        signed_at = date(signature.get('signedAt'), 'INVALID_SIGNING_TIME')
    except VerificationError:
        result['status'] = 'INVALID_SIGNING_TIME'
        return result
    if (signed_at > now or signed_at < date(key['validFrom'])
            or (key['validUntil'] is not None and signed_at > date(key['validUntil']))
            or (key['status'] == 'RETIRED' and signed_at > date(key['statusEffectiveAt']))):
        result['status'] = 'KEY_OUTSIDE_VALIDITY'
        return result
    result.update({'keyTrustedAtSnapshot': True, 'historicalTrust': 'TRUSTED_AT_REGISTRY_SNAPSHOT'})
    return result

def verify_supplement_snapshot(package, metadata, name_set, hashes, read_json, core_sha, proof_id, keys, trust, now, registry_mode):
    """Verify each received signed entry verbatim; never recanonicalize arbitrary facts.

    The inventory/head is an export declaration, not a timestamp-authority promise
    that no later signed entries exist. Truncation beyond a rewritten declared head
    is indistinguishable from a legitimately older received snapshot offline.
    """
    sources = package.get('sources', {})
    if not isinstance(sources, dict):
        fail('INVALID_PACKAGE', 'Invalid package source descriptor')
    descriptor = sources.get('signedSupplements')
    if descriptor is None:
        if 'proof-supplements.json' in name_set:
            fail('INVALID_PACKAGE', 'Signed supplements need an explicit received-snapshot descriptor')
        return {'status': 'NOT_INCLUDED_LEGACY_OR_UNDECLARED', 'coveredByRootSignature': False,
                'chainContinuityVerified': False, 'signaturesVerified': False,
                'completeness': 'NOT_ESTABLISHED', 'currentRevocationKnowledge': 'UNAVAILABLE_OFFLINE'}
    if (not isinstance(descriptor, dict) or set(descriptor) != {'path', 'sequence', 'sha256', 'snapshotAt'}
            or descriptor['path'] != 'proof-supplements.json'
            or type(descriptor['sequence']) is not int or descriptor['sequence'] < 0
            or not isinstance(descriptor['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', descriptor['sha256'])):
        fail('INVALID_PACKAGE', 'Unsupported signed supplement snapshot descriptor')
    if descriptor['path'] not in hashes:
        fail('MISSING_FILES', 'Declared supplement snapshot is absent from the file inventory')
    if metadata and isinstance(metadata.get('sources'), dict):
        mirror = metadata['sources'].get('signedSupplements')
        if mirror is not None and mirror != descriptor:
            fail('SUPPLEMENT_SNAPSHOT_MISMATCH', 'Supplement descriptors disagree')
    snapshot_at = date(descriptor['snapshotAt'], 'INVALID_PACKAGE')
    if snapshot_at > now:
        fail('SUPPLEMENT_SNAPSHOT_MISMATCH', 'Supplement snapshot is dated in the future')
    snapshot = read_json(descriptor['path'])
    if (not isinstance(snapshot, dict) or snapshot.get('schema') != 'packproof.signed-supplement-snapshot.v1'
            or snapshot.get('proofId') != proof_id or snapshot.get('coreManifestSha256') != core_sha
            or snapshot.get('sequence') != descriptor['sequence'] or type(snapshot.get('sequence')) is not int
            or snapshot.get('sha256') != descriptor['sha256'] or snapshot.get('snapshotAt') != descriptor['snapshotAt']
            or not isinstance(snapshot.get('supplements'), list) or len(snapshot['supplements']) > MAX_ENTRIES
            or len(snapshot['supplements']) != descriptor['sequence']):
        fail('SUPPLEMENT_SNAPSHOT_MISMATCH', 'Signed supplement snapshot identity, declared head or count disagrees')
    previous = core_sha
    seen_ids, seen_operations, accepted = {}, set(), []
    kinds = {'CORRECTION', 'RECIPIENT_RESPONSE', 'PARCEL', 'CARRIER_UPDATE', 'RETURN'}
    for sequence, row in enumerate(snapshot['supplements'], 1):
        if (not isinstance(row, dict) or not isinstance(row.get('canonicalJson'), str)
                or not isinstance(row.get('supplementId'), str) or not row['supplementId']
                or row['supplementId'] in seen_ids or row.get('kind') not in kinds
                or not isinstance(row.get('sha256'), str) or not re.fullmatch('[a-f0-9]{64}', row['sha256'])):
            fail('SUPPLEMENT_CHAIN_INVALID', 'Malformed or duplicate signed supplement')
        raw = row['canonicalJson'].encode('utf-8')
        if len(raw) > MAX_JSON or digest(raw) != row['sha256']:
            fail('SUPPLEMENT_INTEGRITY_FAILURE', 'Signed supplement bytes differ from their recorded digest')
        facts = json_bytes(raw)
        if (not isinstance(facts, dict) or type(facts.get('version')) is not int or facts['version'] != 1
                or facts.get('domain') != 'PACKPROOF_PROOF_SUPPLEMENT'
                or row.get('proofId') != proof_id or facts.get('proofId') != proof_id
                or type(row.get('sequence')) is not int or row['sequence'] != sequence
                or type(facts.get('sequence')) is not int or facts['sequence'] != sequence
                or row.get('previousSha256') != previous or facts.get('previousSha256') != previous
                or row.get('coreManifestSha256') != core_sha or facts.get('coreManifestSha256') != core_sha
                or facts.get('supplementId') != row['supplementId'] or facts.get('kind') != row['kind']
                or facts.get('recordedAt') != row.get('createdAt') or not isinstance(facts.get('facts'), dict)):
            fail('SUPPLEMENT_CHAIN_INVALID', 'Signed supplement scope, order, ancestry or representation disagrees')
        if date(row['createdAt'], 'INVALID_PACKAGE') > snapshot_at:
            fail('SUPPLEMENT_SNAPSHOT_MISMATCH', 'Supplement was recorded after the declared snapshot')
        actor, operation = facts.get('actorUserId'), facts.get('operationId')
        if ((actor is not None and not isinstance(actor, str)) or not isinstance(operation, str)
                or not operation or (actor, operation) in seen_operations
                or facts.get('attribution') != ('PARTICIPANT_SUPPLIED' if actor else 'AUTHORIZED_WORKFLOW')):
            fail('SUPPLEMENT_CHAIN_INVALID', 'Supplement attribution or operation identity is inconsistent')
        supersedes = facts.get('supersedesSupplementId')
        if supersedes is not None and (row['kind'] != 'CORRECTION' or supersedes not in seen_ids
                                       or seen_ids[supersedes] != actor):
            fail('SUPPLEMENT_CHAIN_INVALID', 'A correction does not reference the same actor earlier in this chain')
        signature = row.get('signature')
        if not isinstance(signature, dict) or set(signature) != {'algorithm', 'keyId', 'signatureBase64', 'signedAt'}:
            fail('SUPPLEMENT_INTEGRITY_FAILURE', 'A signed supplement requires complete signing context')
        if date(signature['signedAt'], 'INVALID_PACKAGE') > snapshot_at:
            fail('SUPPLEMENT_SNAPSHOT_MISMATCH', 'Supplement signing time exceeds the declared snapshot')
        result = (check_registry_signature(raw, signature, keys, now) if registry_mode
                  else check_signature(raw, signature, keys))
        trusted = result['status'] == 'VERIFIED' and (not registry_mode or result.get('keyTrustedAtSnapshot') is True)
        accepted.append({'supplementId': row['supplementId'], 'sequence': sequence, 'sha256': row['sha256'],
                         'signature': result, 'keyTrustedAtSnapshot': trusted})
        seen_ids[row['supplementId']] = actor
        seen_operations.add((actor, operation))
        previous = row['sha256']
    if previous != descriptor['sha256']:
        fail('SUPPLEMENT_SNAPSHOT_MISMATCH', 'Received signed chain does not reach the declared head')
    all_math = bool(accepted) and all(row['signature']['verified'] for row in accepted)
    all_trusted = bool(accepted) and all(row['keyTrustedAtSnapshot'] for row in accepted)
    status = 'EMPTY_RECEIVED_SNAPSHOT' if not accepted else 'VERIFIED_RECEIVED_SNAPSHOT'
    if accepted:
        for row in accepted:
            if not row['keyTrustedAtSnapshot']:
                status = row['signature']['status']
                break
        if all_trusted and trust['status'] != 'FRESH':
            status = 'TRUST_STALE' if trust['status'] == 'STALE' else 'TRUST_NOT_YET_VALID'
    return {'status': status, 'coveredByRootSignature': False, 'chainContinuityVerified': True,
            'signaturesVerified': all_math, 'keysTrustedAtSnapshot': all_trusted,
            'fullyVerifiedReceivedChain': all_trusted and trust['status'] == 'FRESH',
            'sequence': len(accepted), 'headSha256': previous, 'coreManifestSha256': core_sha,
            'snapshotAt': descriptor['snapshotAt'], 'entries': accepted,
            'completeness': 'RECEIVED_SNAPSHOT_ONLY', 'currentRevocationKnowledge': 'UNAVAILABLE_OFFLINE',
            'snapshotTimeIndependentlyAttested': False,
            'limitation': 'This is the received signed chain only. An older valid prefix cannot prove that no later supplements exist.'}

def verify(path, expected=None, trust_path=None, now=None, registry_path=None,
           authority_key_path=None, authority_key_id=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    if trust_path and registry_path:
        fail('INVALID_TRUST_REGISTRY', 'Choose a legacy trust list or a signed registry, not both')
    if not registry_path and (authority_key_path or authority_key_id):
        fail('INVALID_TRUST_REGISTRY', 'Authority options require a signed registry')
    keys, trust = (load_registry(registry_path, authority_key_path, authority_key_id, now)
                   if registry_path else load_trust(trust_path, now))
    if os.path.getsize(path) > MAX_BYTES:
        fail('UNSAFE_ARCHIVE', 'Archive exceeds compressed size limit')
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_ENTRIES:
            fail('UNSAFE_ARCHIVE', 'Archive has too many entries')
        names = [i.filename for i in entries]
        if len(names) != len(set(names)):
            fail('UNSAFE_ARCHIVE', 'Duplicate ZIP entries')
        if any(not safe_name(n) for n in names):
            fail('UNSAFE_ARCHIVE', 'Unsafe archive path')
        total = 0
        for entry in entries:
            total += entry.file_size
            mode = entry.external_attr >> 16
            if ((stat.S_IFMT(mode) not in (0, stat.S_IFREG)) or entry.flag_bits & 1
                    or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                    or entry.file_size > MAX_BYTES or total > MAX_BYTES
                    or entry.file_size > max(entry.compress_size, 1) * 200):
                fail('UNSAFE_ARCHIVE', 'Unsafe entry type, compression, or expanded size')
        name_set = set(names)
        def read(name):
            if not safe_name(name):
                fail('UNSAFE_ARCHIVE', 'Unsafe indexed archive path')
            if name not in name_set:
                fail('MISSING_FILES', 'Required file is missing: ' + name)
            try:
                return archive.read(name)
            except (zipfile.BadZipFile, RuntimeError, EOFError):
                fail('MODIFIED_FILES', 'Corrupt archive entry: ' + name)
        def read_json(name):
            if name in name_set and archive.getinfo(name).file_size > MAX_JSON:
                fail('UNSAFE_ARCHIVE', 'JSON entry exceeds size limit')
            return json_bytes(read(name))
        package = read_json('package.json')
        if not isinstance(package, dict) or package.get('schema') not in ('packproof.proof-package.v1', 'packproof.disclosure-package.v1'):
            fail('UNSUPPORTED_VERSION', 'Unsupported Proof package version')
        metadata = read_json('archive.json') if 'archive.json' in name_set else None
        if metadata is not None and (metadata.get('schema') != 'packproof.proof-archive.v1'
                or metadata.get('canonicalization') != 'packproof.sorted-json.v1'):
            fail('UNSUPPORTED_VERSION', 'Unsupported archive or canonicalization version')
        hashes = read_json('integrity/hashes.json')
        if not isinstance(hashes, dict) or len(hashes) > MAX_ENTRIES:
            fail('INVALID_PACKAGE', 'Invalid archive hash inventory')
        for name, expected_hash in hashes.items():
            if not isinstance(expected_hash, str) or not re.fullmatch('[a-f0-9]{64}', expected_hash):
                fail('INVALID_PACKAGE', 'Invalid SHA-256 in inventory')
            if digest(read(name)) != expected_hash:
                fail('MODIFIED_FILES', 'Hash mismatch: ' + name)
        # Legacy v1 omitted README from its index. No executable or hidden extras are accepted.
        if name_set - set(hashes) - {'integrity/hashes.json', 'README.txt'}:
            fail('UNINDEXED_FILES', 'Archive contains files outside the hash inventory')
        if package['schema'] == 'packproof.disclosure-package.v1':
            if not {'package.json', 'view.json'}.issubset(hashes):
                fail('INVALID_PACKAGE', 'Disclosure view is absent from the hash inventory')
            if 'manifest.json' in name_set or package.get('signature') is not None:
                fail('INVALID_PACKAGE', 'A scoped view cannot claim the complete signed manifest')
            raw_view = read('view.json')
            view = json_bytes(raw_view)
            if (digest(raw_view) != package.get('projectionSha256')
                    or view.get('proofId') != package.get('proofId')
                    or view.get('disclosure') != package.get('disclosure')):
                fail('MODIFIED_FILES', 'Disclosure representations disagree')
            entries = package.get('media')
            if not isinstance(entries, list):
                fail('INVALID_PACKAGE', 'Invalid disclosure media inventory')
            identities = {entry['evidenceId'] for entry in entries}
            selected = {entry['evidenceId']: entry for entry in view.get('evidence', [])}
            if len(identities) != len(entries) or identities != set(selected):
                fail('INVALID_PACKAGE', 'Disclosure media selection disagrees')
            media_paths = set()
            for entry in entries:
                media_path = entry.get('path')
                if media_path not in hashes or media_path in media_paths:
                    fail('INVALID_PACKAGE', 'Unindexed or duplicate disclosure media')
                media_paths.add(media_path)
                data = read(media_path)
                source = selected[entry['evidenceId']]
                if (digest(data) != entry['sha256'] or len(data) != entry['byteSize']
                        or source.get('representation') != entry.get('representation')
                        or source.get('derivativeId') != entry.get('derivativeId')):
                    fail('MODIFIED_FILES', 'Disclosed media representations disagree')
            if name_set != {'package.json', 'view.json', 'integrity/hashes.json'} | media_paths:
                fail('INVALID_PACKAGE', 'Disclosure archive contains unexpected files')
            return {'verifierVersion': VERSION, 'status': 'DISCLOSURE_ONLY',
                    'proofId': package['proofId'], 'signatureVerified': False,
                    'archiveHashInventoryVerified': True, 'evidenceVerified': 0,
                    'files': [{'path': name, 'sha256': value, 'status': 'HASH_MATCHED'} for name, value in sorted(hashes.items())],
                    'includedDisclosureFilesChecked': len(entries), 'completeMedia': False,
                    'scope': package['disclosure'], 'trust': trust,
                    'omissions': package.get('omissions', []),
                    'limitations': ['Only recipient-view self-consistency was checked.',
                                   'The frozen root and withheld original media were not verified.',
                                   'No media was uploaded.']}
        required = {'package.json', 'manifest.json', 'integrity/evidence.json', 'lifecycle/stages.json'}
        if not required.issubset(hashes):
            fail('INVALID_PACKAGE', 'Required files are absent from the hash inventory')
        raw = read('manifest.json')
        manifest = json_bytes(raw)
        if manifest.get('manifestVersion') != 1:
            fail('UNSUPPORTED_VERSION', 'Unsupported canonical manifest version')
        actual = digest(raw)
        if (actual != package.get('manifestSha256') or package.get('canonicalJson', '').encode('utf-8') != raw
                or package.get('canonicalManifest') != manifest or package.get('proofId') != manifest.get('proofId')):
            fail('MODIFIED_FILES', 'Frozen manifest representations or identity disagree')
        if expected and actual != expected.lower():
            fail('MODIFIED_FILES', 'Manifest differs from independently supplied digest')
        if metadata is not None and metadata.get('snapshot') != {
                'proofId': manifest['proofId'], 'manifestId': package.get('manifestId'), 'manifestSha256': actual}:
            fail('MODIFIED_FILES', 'Archive snapshot differs from frozen manifest')
        omissions = []
        seen_paths = set()
        def media_check(inventory, evidence, stage_id=None):
            if not isinstance(inventory, list) or not isinstance(evidence, list):
                fail('INVALID_PACKAGE', 'Invalid media inventory')
            lookup = {e['evidenceId']: e for e in inventory}
            frozen = {e['evidenceId']: e for e in evidence}
            if len(lookup) != len(inventory) or len(frozen) != len(evidence) or set(lookup) != set(frozen):
                fail('INVALID_PACKAGE', 'Media inventory differs from frozen manifest')
            verified = 0
            for evidence_id, source in frozen.items():
                entry = lookup[evidence_id]
                if entry.get('status') == 'OMITTED':
                    if (entry.get('path') is not None or entry.get('reason') not in ('UNAVAILABLE', 'WITHHELD_BY_SCOPE')
                            or entry.get('sha256') != source['sha256'] or entry.get('byteSize') != source['byteSize']):
                        fail('INVALID_PACKAGE', 'Invalid media omission declaration')
                    omission = {'evidenceId': evidence_id, 'reason': entry['reason']}
                    if stage_id is not None:
                        omission['stageId'] = stage_id
                    omissions.append(omission)
                    continue
                media_path = entry.get('path')
                if media_path in seen_paths or media_path not in hashes:
                    fail('INVALID_PACKAGE', 'Duplicated or unindexed media reference')
                seen_paths.add(media_path)
                data = read(media_path)
                if len(data) != source['byteSize'] or digest(data) != source['sha256']:
                    fail('MODIFIED_FILES', 'Media differs from frozen manifest: ' + evidence_id)
                verified += 1
            return verified
        count = media_check(read_json('integrity/evidence.json'), manifest['evidence'])
        stages = read_json('lifecycle/stages.json')
        stage_hashes = {s['stageId']: s['sha256'] for s in stages}
        if len(stage_hashes) != len(stages):
            fail('INVALID_PACKAGE', 'Duplicate lifecycle stage')
        stage_count = 0
        seen_stages = set()
        for stage in stages:
            if stage['manifestPath'] not in hashes:
                fail('INVALID_PACKAGE', 'Unindexed lifecycle manifest')
            stage_raw = read(stage['manifestPath'])
            stage_manifest = json_bytes(stage_raw)
            if (digest(stage_raw) != stage['sha256'] or stage_manifest['baseManifestSha256'] != actual
                    or stage_manifest['proofId'] != manifest['proofId']):
                fail('MODIFIED_FILES', 'Lifecycle manifest mismatch')
            previous = stage_manifest.get('previousStage')
            if previous and (previous['stageId'] not in seen_stages
                             or stage_hashes.get(previous['stageId']) != previous['sha256']):
                fail('INVALID_PACKAGE', 'Lifecycle chain is incomplete, cyclic, or out of order')
            seen_stages.add(stage['stageId'])
            stage_count += media_check(stage['evidence'], stage_manifest['evidence'], stage['stageId'])
        if metadata is not None and metadata.get('omissions') != omissions:
            fail('INVALID_PACKAGE', 'Omission inventories disagree')
        signature = (check_registry_signature(raw, package.get('signature'), keys, now)
                     if registry_path else check_signature(raw, package.get('signature'), keys))
        if 'integrity/signatures.json' in name_set:
            signatures = read_json('integrity/signatures.json')
            if signatures.get('manifestSignature') != package.get('signature'):
                fail('INVALID_PACKAGE', 'Signature inventories disagree')
        supplements = verify_supplement_snapshot(package, metadata, name_set, hashes, read_json, actual, manifest['proofId'], keys, trust, now, bool(registry_path))
        status = signature['status']
        if status == 'UNSIGNED' and expected:
            status = 'VERIFIED_INDEPENDENT_DIGEST'
        if status == 'VERIFIED' and trust['status'] != 'FRESH':
            status = 'TRUST_STALE' if trust['status'] == 'STALE' else 'TRUST_NOT_YET_VALID'
        if status in ('VERIFIED', 'VERIFIED_INDEPENDENT_DIGEST') and supplements['status'] not in ('VERIFIED_RECEIVED_SNAPSHOT', 'EMPTY_RECEIVED_SNAPSHOT', 'NOT_INCLUDED_LEGACY_OR_UNDECLARED'):
            status = 'SUPPLEMENT_' + supplements['status']
        if omissions and status in ('VERIFIED', 'VERIFIED_INDEPENDENT_DIGEST', 'UNSIGNED'):
            status = 'OMITTED_FILES'
        return {'verifierVersion': VERSION, 'status': status,
                'proofId': manifest['proofId'], 'manifestSha256': actual,
                'evidenceVerified': count, 'lifecycleEvidenceVerified': stage_count,
                'archiveHashInventoryVerified': True, 'independentDigestMatched': bool(expected),
                'files': [{'path': name, 'sha256': value, 'status': 'HASH_MATCHED'} for name, value in sorted(hashes.items())],
                'signatureVerified': signature['verified'], 'signature': signature, 'trust': trust,
                'omissions': omissions, 'completeMedia': not omissions,
                'scope': metadata.get('disclosure') if metadata else {'kind': 'LEGACY_PARTICIPANT_EXPORT'},
                'supplements': supplements,
                'otherSupplementalFiles': {'status': 'SELF_CONSISTENCY_ONLY', 'coveredByRootSignature': False},
                'limitations': ['Integrity does not establish physical truth, authenticity, or liability.',
                               'The root signature does not cover later supplements. Each declared signed entry is checked separately; other export files remain inventory self-consistency only.',
                               'A received signed chain cannot establish that no later events exist. Its export snapshot time is not independently attested.',
                               'Archive-included keys never establish trust. No media was uploaded.']}

def render_html_report(result):
    """A static local report: escaped text only, no archive links, active media, or scripts."""
    escape = lambda value: html.escape(str(value), quote=True)
    status = result.get('status', 'INVALID_PACKAGE')
    color = '#147d54' if status in ('VERIFIED', 'VERIFIED_INDEPENDENT_DIGEST') else '#945800'
    summary = [
        ('Result', status),
        ('Proof', result.get('proofId', 'Not established')),
        ('Frozen manifest SHA-256', result.get('manifestSha256', 'Not independently checked')),
        ('Original files verified', result.get('evidenceVerified', 0)),
        ('Later-stage files checked', result.get('lifecycleEvidenceVerified', 0)),
        ('Signature verified', 'Yes' if result.get('signatureVerified') else 'No'),
        ('Trust freshness', result.get('trust', {}).get('status', 'Not checked')),
        ('Trust snapshot expires', result.get('trust', {}).get('expiresAt', 'Not provided')),
        ('Signed supplement chain', result.get('supplements', {}).get('status', 'Not checked')),
        ('Received supplement sequence', result.get('supplements', {}).get('sequence', 'Not established')),
        ('Received supplement head', result.get('supplements', {}).get('headSha256', 'Not established')),
        ('Supplement completeness', result.get('supplements', {}).get('completeness', 'Not established')),
    ]
    rows = ''.join('<tr><th scope="row">' + escape(label) + '</th><td>' + escape(value) + '</td></tr>' for label, value in summary)
    inventory = ''.join('<tr><td>' + escape(item.get('path', '')) + '</td><td><code>' + escape(item.get('sha256', '')) + '</code></td><td>' + escape(item.get('status', '')) + '</td></tr>' for item in result.get('files', []))
    if not inventory:
        inventory = '<tr><td colspan="3">No complete file inventory was established.</td></tr>'
    limitations = result.get('limitations', []) + [
        'This report is a static view of a local check. Its own contents are not cryptographically signed.',
        'Export file hashes alone establish self-consistency. Declared signed supplement entries are authenticated separately and reported above.',
        'The received supplement head does not establish whether unseen later entries exist.',
        'The archive was not extracted. No archive media, scripts, or links are embedded or executed.',
        'Integrity does not establish physical truth, authenticity, or liability.',
    ]
    notes = ''.join('<li>' + escape(note) + '</li>' for note in limitations)
    message = '<p>' + escape(result['message']) + '</p>' if result.get('message') else ''
    omissions = escape(json.dumps(result.get('omissions', []), indent=2, ensure_ascii=True))
    details = escape(json.dumps(result, indent=2, ensure_ascii=True))
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">'
            '<title>PackProof offline verification report</title><style>'
            'body{font:16px/1.55 system-ui,sans-serif;color:#163249;background:#f4f8fb;margin:0;padding:32px}'
            'main{max-width:1000px;margin:auto;background:white;padding:32px;border-radius:16px}'
            'h1{margin-top:0}h2{margin-top:32px}table{border-collapse:collapse;width:100%;font-size:14px}'
            'th,td{text-align:left;vertical-align:top;border-bottom:1px solid #dce6ed;padding:12px;overflow-wrap:anywhere}'
            'th{font-weight:600}code,pre{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}'
            '.status{font-size:20px;font-weight:700;color:' + color + '}.muted{color:#526c7c}'
            '@media(max-width:600px){body{padding:8px}main{padding:16px}th,td{padding:8px}}'
            '@media print{body{background:white;padding:0}main{padding:0}}'
            '</style></head><body><main><p class="muted">PACKPROOF / OFFLINE VERIFIER ' + escape(VERSION) + '</p>'
            '<h1>Verification report</h1><p class="status">' + escape(status.replace('_', ' ')) + '</p>' + message +
            '<table aria-label="Verification summary"><tbody>' + rows + '</tbody></table>'
            '<h2>Files checked</h2><p class="muted">Source filenames are plain text. No archive content is opened by this report.</p>'
            '<table><thead><tr><th>Source file</th><th>SHA-256</th><th>Inventory check</th></tr></thead><tbody>' + inventory + '</tbody></table>'
            '<h2>Explicit omissions</h2><pre>' + omissions + '</pre><h2>What this check means</h2><ul>' + notes + '</ul>'
            '<details><summary>Complete verification result</summary><pre>' + details + '</pre></details>'
            '</main></body></html>')

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package', nargs='?')
    parser.add_argument('--expected-manifest-sha256')
    parser.add_argument('--trust-list', help='Separately obtained authenticated trust-list JSON; never use a package-included key')
    parser.add_argument('--trust-registry', help='Signed, dated registry JSON authenticated with an independently pinned authority')
    parser.add_argument('--trust-authority-key', help='Independently pinned registry-authority public PEM file, outside the archive')
    parser.add_argument('--trust-authority-key-id', help='Independently obtained identity of the pinned registry authority')
    parser.add_argument('--html-report', help='Create a new static offline HTML report; existing files are never overwritten')
    parser.add_argument('--version', action='version', version=VERSION)
    args = parser.parse_args(argv)
    if not args.package:
        parser.error('package path is required')
    if args.expected_manifest_sha256 and not re.fullmatch('[a-fA-F0-9]{64}', args.expected_manifest_sha256):
        parser.error('expected manifest SHA-256 must contain exactly 64 hexadecimal characters')
    exit_code = 1
    try:
        result = verify(args.package, args.expected_manifest_sha256, args.trust_list,
                        registry_path=args.trust_registry, authority_key_path=args.trust_authority_key,
                        authority_key_id=args.trust_authority_key_id)
        exit_code = 0 if result['status'] in ('VERIFIED', 'VERIFIED_INDEPENDENT_DIGEST') else 2
    except VerificationError as error:
        result = {'verifierVersion': VERSION, 'status': error.status, 'message': str(error)}
        if error.status == 'SIGNATURE_UNCHECKED':
            exit_code = 2
    except zipfile.BadZipFile:
        result = {'verifierVersion': VERSION, 'status': 'INVALID_ARCHIVE', 'message': 'Malformed ZIP archive'}
    except (ValueError, TypeError, KeyError, AttributeError, OSError, OverflowError, RecursionError):
        result = {'verifierVersion': VERSION, 'status': 'INVALID_PACKAGE', 'message': 'Malformed or unreadable package data'}
    if args.html_report:
        try:
            # Exclusive create protects the input archive, trust list, and existing files/symlinks.
            with open(args.html_report, 'x', encoding='utf-8') as report:
                report.write(render_html_report(result))
        except (OSError, ValueError, TypeError):
            result['reportError'] = 'Could not create HTML report; choose a new writable path.'
            exit_code = 1
    print(json.dumps(result, indent=2, ensure_ascii=True))
    return exit_code

if __name__ == '__main__':
    sys.exit(main())
