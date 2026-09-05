#!/usr/bin/env python3
"""PackProof independent offline ZIP verifier v1.0.0 (Python 3.10+, OpenSSL for signatures).
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

VERSION = '1.0.0'
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

def date(value):
    if not isinstance(value, str):
        fail('INVALID_TRUST_LIST', 'Trust timestamps must be ISO 8601 strings')
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed
    except ValueError:
        fail('INVALID_TRUST_LIST', 'Trust timestamp must include a timezone')

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

def verify(path, expected=None, trust_path=None, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    keys, trust = load_trust(trust_path, now)
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
        signature = check_signature(raw, package.get('signature'), keys)
        if 'integrity/signatures.json' in name_set:
            signatures = read_json('integrity/signatures.json')
            if signatures.get('manifestSignature') != package.get('signature'):
                fail('INVALID_PACKAGE', 'Signature inventories disagree')
        status = signature['status']
        if status == 'UNSIGNED' and expected:
            status = 'VERIFIED_INDEPENDENT_DIGEST'
        if signature['verified'] and trust['status'] != 'FRESH':
            status = 'TRUST_STALE' if trust['status'] == 'STALE' else 'TRUST_NOT_YET_VALID'
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
                'supplements': {'status': 'SELF_CONSISTENCY_ONLY', 'coveredByRootSignature': False},
                'limitations': ['Integrity does not establish physical truth, authenticity, or liability.',
                               'The root signature does not cover later supplements or an export inventory.',
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
        ('Trust list expires', result.get('trust', {}).get('expiresAt', 'Not provided')),
    ]
    rows = ''.join('<tr><th scope="row">' + escape(label) + '</th><td>' + escape(value) + '</td></tr>' for label, value in summary)
    inventory = ''.join('<tr><td>' + escape(item.get('path', '')) + '</td><td><code>' + escape(item.get('sha256', '')) + '</code></td><td>' + escape(item.get('status', '')) + '</td></tr>' for item in result.get('files', []))
    if not inventory:
        inventory = '<tr><td colspan="3">No complete file inventory was established.</td></tr>'
    limitations = result.get('limitations', []) + [
        'This report is a static view of a local check. Its own contents are not cryptographically signed.',
        'File hashes in an export inventory establish self-consistency; they do not independently authenticate later supplements.',
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
    parser.add_argument('--html-report', help='Create a new static offline HTML report; existing files are never overwritten')
    parser.add_argument('--version', action='version', version=VERSION)
    args = parser.parse_args(argv)
    if not args.package:
        parser.error('package path is required')
    if args.expected_manifest_sha256 and not re.fullmatch('[a-fA-F0-9]{64}', args.expected_manifest_sha256):
        parser.error('expected manifest SHA-256 must contain exactly 64 hexadecimal characters')
    exit_code = 1
    try:
        result = verify(args.package, args.expected_manifest_sha256, args.trust_list)
        exit_code = 0 if result['status'] in ('VERIFIED', 'VERIFIED_INDEPENDENT_DIGEST') else 2
    except VerificationError as error:
        result = {'verifierVersion': VERSION, 'status': error.status, 'message': str(error)}
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
