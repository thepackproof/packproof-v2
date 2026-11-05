"""Independent, offline operational snapshot verifier. Never executes archive content.

This is a distinct closed JCS/ES256 profile. Legacy signed bytes are not passed
through this serializer. Only an independently authenticated issuer/key history
can establish trust; public keys supplied by the archive are never accepted.
"""
import datetime as dt
import hashlib
import math
import re
from pathlib import Path

from envelope import b64, check, exact, identifier as trusted_identifier, json_value, safe_path, sha, stamp

PROFILE = 'packproof.operational-snapshot.v1'
MANIFEST = 'packproof.operational-record-manifest.v1'
PACKAGE = 'packproof.operational-snapshot-package.v1'
TYPE = 'application/packproof-operational-snapshot+jws'
MANIFEST_PATH = 'operational/manifest.json'
ENVELOPE_PATH = 'operational/envelope.jws.json'
CORE_PATH = 'core/manifest.json'
PRIOR_PATH = 'operational/prior-manifest.json'
SECTIONS = {
    'entities': 'id proof_id kind external_reference parent_id attributes actor_user_id supersedes_id created_at',
    'links': 'id proof_id evidence_id subject_id reason actor_user_id created_at',
    'requirements': 'id proof_id subject_id stage title template_version accepted_evidence_types due_at grace_period_ms created_at evaluation_status matching_artifact_ids',
    'waivers': 'id requirement_id reason actor_user_id created_at',
    'issues': 'id proof_id category severity title subject_id rule_version compared_sources created_at',
    'actions': 'id sequence issue_id action reason actor_user_id created_at',
    'amendments': 'id proof_id supersedes_id assertion reason actor_user_id created_at',
}


def identifier(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,160}', value) is not None


def text(value, maximum=2000, nullable=False):
    return value is None and nullable or (isinstance(value, str) and len(value) <= maximum and not re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff]', value))


def bounded_json(value, depth=0):
    check(depth <= 12, 'Operational JSON nesting exceeds limit')
    if isinstance(value, dict):
        check(len(value) <= 1000 and all(text(key, 200) for key in value), 'Invalid operational JSON members')
        for item in value.values():
            bounded_json(item, depth + 1)
    elif isinstance(value, list):
        check(len(value) <= 10000, 'Operational JSON list exceeds limit')
        for item in value:
            bounded_json(item, depth + 1)
    else:
        check(value is None or type(value) in (str, int, float, bool), 'Invalid operational JSON value')
        if isinstance(value, str):
            check(text(value, 20000), 'Invalid operational JSON text')
        if type(value) in (int, float):
            check(math.isfinite(value) and abs(value) <= 9007199254740991, 'Operational number is outside JCS safe bounds')


def validate_manifest(manifest):
    """Validate membership and references without turning source assertions into truth."""
    exact(manifest, 'profile assertion snapshotId organizationId environment proofId revision priorSnapshot core evaluation actor record entities links requirements waivers issues actions amendments artifacts omissions')
    check(manifest['profile'] == MANIFEST and manifest['assertion'] == 'ORGANIZATION_SUBMITTED', 'Unsupported operational assertion profile')
    check(all(identifier(manifest[key]) for key in ('snapshotId', 'organizationId', 'proofId')) and manifest['environment'] in ('live', 'sandbox') and type(manifest['revision']) is int and 0 < manifest['revision'] <= 9007199254740991, 'Invalid operational identity')
    prior = manifest['priorSnapshot']
    if prior is not None:
        exact(prior, 'snapshotId manifestSha256')
        check(identifier(prior['snapshotId']) and prior['snapshotId'] != manifest['snapshotId'] and sha(prior['manifestSha256']), 'Invalid prior snapshot link')
    exact(manifest['core'], 'manifestSha256')
    check(manifest['core']['manifestSha256'] is None or sha(manifest['core']['manifestSha256']), 'Invalid core linkage')
    exact(manifest['evaluation'], 'at version')
    check(manifest['evaluation']['version'] == 'packproof.requirement-evaluation.v1', 'Unsupported requirement evaluation profile')
    evaluated = stamp(manifest['evaluation']['at'])
    exact(manifest['actor'], 'userId membershipId role locationId')
    check(identifier(manifest['actor']['userId']) and identifier(manifest['actor']['membershipId']) and manifest['actor']['role'] in ('OWNER', 'ADMIN') and (manifest['actor']['locationId'] is None or identifier(manifest['actor']['locationId'])), 'Invalid human admission attribution')
    exact(manifest['record'], 'title reference lifecycle reviewState locationId updatedAt')
    check(all(text(manifest['record'][key], nullable=True) for key in ('title', 'reference')) and manifest['record']['lifecycle'] in ('open', 'closed') and manifest['record']['reviewState'] in ('unreviewed', 'reviewed') and (manifest['record']['locationId'] is None or identifier(manifest['record']['locationId'])), 'Invalid frozen record')
    check(manifest['actor']['locationId'] == manifest['record']['locationId'], 'Human admission location does not match frozen record')
    check(stamp(manifest['record']['updatedAt']) <= evaluated, 'Record update exceeds evaluation cutoff')
    section_maps = {}
    for name, fields in SECTIONS.items():
        rows = manifest[name]
        check(isinstance(rows, list) and len(rows) <= 10000, 'Invalid operational section size')
        indexed = {}
        for row in rows:
            exact(row, fields)
            check(identifier(row['id']) and row['id'] not in indexed, 'Duplicate operational row identity')
            if 'proof_id' in row:
                check(row['proof_id'] == manifest['proofId'], 'Cross-Proof operational row')
            if 'actor_user_id' in row:
                check(identifier(row['actor_user_id']), 'Invalid row actor')
            check(stamp(row['created_at']) <= evaluated, 'Operational addition exceeds frozen cutoff')
            if 'reason' in row:
                check(text(row['reason']), 'Invalid operational reason')
            indexed[row['id']] = row
        section_maps[name] = indexed
    subjects = {manifest['proofId']} | set(section_maps['entities'])
    for row in manifest['entities']:
        check(row['kind'] in ('shipment', 'stop', 'package', 'pallet', 'item', 'return') and text(row['external_reference'], nullable=True) and isinstance(row['attributes'], dict), 'Invalid entity')
        bounded_json(row['attributes'])
        for relation in ('parent_id', 'supersedes_id'):
            check(row[relation] is None or row[relation] in section_maps['entities'] and row[relation] != row['id'], 'Missing entity relation')
        if row['supersedes_id']:
            check(section_maps['entities'][row['supersedes_id']]['kind'] == row['kind'], 'Entity amendment changes kind')
    for relation in ('parent_id', 'supersedes_id'):
        for row in manifest['entities']:
            seen, current = set(), row
            while current[relation] is not None:
                check(current['id'] not in seen, 'Cyclic entity relation')
                seen.add(current['id']); current = section_maps['entities'][current[relation]]
    artifacts, omissions = {}, {}
    check(isinstance(manifest['artifacts'], list) and len(manifest['artifacts']) <= 4000 and isinstance(manifest['omissions'], list) and len(manifest['omissions']) <= 10000, 'Invalid artifact inventory size')
    artifact_bytes = 0
    for artifact in manifest['artifacts']:
        exact(artifact, 'artifactId path kind sha256 byteSize contentType evidenceType storage source derivation')
        check(identifier(artifact['artifactId']) and artifact['artifactId'] not in artifacts and artifact['path'] == 'originals/' + artifact['artifactId'] and safe_path(artifact['path']), 'Duplicate or unsafe original path')
        check(artifact['kind'] in ('CAPTURE_ORIGINAL', 'SOURCE_ARTIFACT') and sha(artifact['sha256']) and type(artifact['byteSize']) is int and 0 <= artifact['byteSize'] <= 9007199254740991 and text(artifact['contentType'], 200) and text(artifact['evidenceType'], 200) and artifact['evidenceType'], 'Invalid exact artifact commitment')
        artifact_bytes += artifact['byteSize']
        check(artifact_bytes <= 200 * 1024 * 1024, 'Operational original inventory exceeds package limit')
        exact(artifact['storage'], 'bucket key versionId')
        check(all(text(artifact['storage'][key], maximum) and artifact['storage'][key] for key, maximum in [('bucket', 63), ('key', 1024), ('versionId', 1024)]) and artifact['storage']['versionId'] != 'null', 'Exact immutable object version required')
        exact(artifact['source'], 'kind reference reportedAt receivedAt acceptedAt actorId connectionId receiptSha256')
        check(text(artifact['source']['kind'], 200) and artifact['source']['kind'] and text(artifact['source']['reference'], nullable=True), 'Invalid artifact attribution')
        check(stamp(artifact['source']['receivedAt']) <= evaluated, 'Artifact received after frozen cutoff')
        check(stamp(artifact['source']['acceptedAt']) <= evaluated and stamp(artifact['source']['acceptedAt']) >= stamp(artifact['source']['receivedAt']), 'Invalid artifact acceptance time')
        check(all(artifact['source'][key] is None or identifier(artifact['source'][key]) for key in ('actorId', 'connectionId')) and (artifact['source']['receiptSha256'] is None or sha(artifact['source']['receiptSha256'])), 'Invalid exact source provenance')
        if artifact['kind'] == 'SOURCE_ARTIFACT':
            check(artifact['source']['actorId'] is not None and artifact['source']['receiptSha256'] is not None, 'Organization source requires actor and accepted receipt commitment')
        if artifact['source']['reportedAt'] is not None:
            stamp(artifact['source']['reportedAt'])
        if artifact['derivation'] is not None:
            exact(artifact['derivation'], 'sourceArtifactId recipeSha256')
            check(identifier(artifact['derivation']['sourceArtifactId']) and sha(artifact['derivation']['recipeSha256']), 'Invalid derivation history')
        artifacts[artifact['artifactId']] = artifact
    for omission in manifest['omissions']:
        exact(omission, 'artifactId reason detail')
        check(identifier(omission['artifactId']) and omission['artifactId'] not in omissions and omission['artifactId'] not in artifacts and omission['reason'] in ('MISSING', 'QUARANTINED', 'WITHHELD', 'UNAVAILABLE', 'PENDING') and text(omission['detail']) and omission['detail'], 'Invalid or conflicting omission')
        omissions[omission['artifactId']] = omission
    membership = set(artifacts) | set(omissions)
    for artifact in artifacts.values():
        if artifact['derivation']:
            check(artifact['derivation']['sourceArtifactId'] in artifacts and artifact['derivation']['sourceArtifactId'] != artifact['artifactId'], 'Undeclared derivation source')
            seen, current = set(), artifact
            while current['derivation'] is not None:
                check(current['artifactId'] not in seen, 'Cyclic artifact derivation')
                seen.add(current['artifactId']); current = artifacts[current['derivation']['sourceArtifactId']]
    for row in manifest['links']:
        check(row['evidence_id'] in membership and row['subject_id'] in subjects, 'Undeclared evidence or subject link')
    waived = set()
    for row in manifest['waivers']:
        check(row['requirement_id'] in section_maps['requirements'] and row['requirement_id'] not in waived, 'Invalid waiver membership')
        waived.add(row['requirement_id'])
    for row in manifest['requirements']:
        check(row['subject_id'] in subjects and all(text(row[key]) for key in ('stage', 'title', 'template_version')) and isinstance(row['accepted_evidence_types'], list) and 0 < len(row['accepted_evidence_types']) <= 100 and all(text(item, 200) for item in row['accepted_evidence_types']) and type(row['grace_period_ms']) is int and 0 <= row['grace_period_ms'] <= 2592000000, 'Invalid requirement')
        if row['due_at'] is not None:
            stamp(row['due_at'])
        matches = row['matching_artifact_ids']
        check(isinstance(matches, list) and len(matches) <= 10000 and len(matches) == len(set(matches)) and all(item in artifacts for item in matches), 'Invalid requirement match inventory')
        eligible = sorted(artifact_id for artifact_id, artifact in artifacts.items() if artifact['evidenceType'] in row['accepted_evidence_types'] and (row['due_at'] is None or stamp(artifact['source']['acceptedAt']) <= stamp(row['due_at']) + dt.timedelta(milliseconds=row['grace_period_ms'])) and ((artifact['kind'] == 'CAPTURE_ORIGINAL' and row['subject_id'] == manifest['proofId']) or any(link['evidence_id'] == artifact_id and link['subject_id'] == row['subject_id'] for link in manifest['links'])))
        check(matches == eligible, 'Requirement evidence evaluation does not match frozen membership')
        expected = 'waived' if row['id'] in waived else 'satisfied' if matches else 'not_yet_due' if row['due_at'] is None or stamp(row['due_at']) + dt.timedelta(milliseconds=row['grace_period_ms']) > evaluated else 'missing'
        check(row['evaluation_status'] == expected, 'Requirement result contradicts frozen evaluation inputs')
        for artifact_id in matches:
            check(row['subject_id'] == manifest['proofId'] or any(link['evidence_id'] == artifact_id and link['subject_id'] == row['subject_id'] for link in manifest['links']), 'Requirement match lacks a subject link')
    for row in manifest['issues']:
        check(row['subject_id'] in subjects and row['severity'] in ('info', 'warning', 'critical') and all(text(row[key], 2000) for key in ('category', 'title', 'rule_version')), 'Invalid issue')
        bounded_json(row['compared_sources'])
    sequences = set()
    for row in manifest['actions']:
        check(row['issue_id'] in section_maps['issues'] and row['action'] in ('acknowledge', 'resolve', 'reopen', 'note') and isinstance(row['sequence'], str) and re.fullmatch('[1-9][0-9]{0,18}', row['sequence']) and row['sequence'] not in sequences, 'Invalid action history')
        sequences.add(row['sequence'])
    for row in manifest['amendments']:
        check(identifier(row['supersedes_id']), 'Invalid amendment target')
        bounded_json(row['assertion'])
    return artifacts, omissions


def verify_signature(jws, envelope, trust_path, now):
    """Keep signature mathematics, issuer identity and independent key policy separate."""
    import rfc8785
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec, utils
    header_bytes = b64(jws['protected'], 4096)
    header = json_value(header_bytes)
    exact(header, 'alg kid typ')
    check(header['alg'] == 'ES256' and header['typ'] == TYPE and trusted_identifier(header['kid']) and rfc8785.dumps(header) == header_bytes, 'Unsupported or noncanonical operational JWS header')
    signature = b64(jws['signature'], 100)
    check(len(signature) == 64, 'ES256 signature must have fixed 64-byte width')
    issued = stamp(envelope['issuedAt'])
    key, trusted, current = None, False, False
    trust = {'status': 'UNAVAILABLE', 'currentRevocationKnowledge': 'UNAVAILABLE_OFFLINE'}
    if trust_path:
        check(Path(trust_path).stat().st_size <= 1024 * 1024, 'Trust file exceeds limit')
        registry = json_value(Path(trust_path).read_bytes())
        exact(registry, 'schema issuer publishedAt nextReviewAt keys')
        check(registry['schema'] == 'packproof.envelope-trust.v1' and text(registry['issuer'], 300) and isinstance(registry['keys'], list) and len(registry['keys']) <= 100, 'Invalid independent issuer history')
        published, expires = stamp(registry['publishedAt']), stamp(registry['nextReviewAt'])
        check(published <= now and expires > published, 'Invalid independent trust dates')
        seen = set()
        for candidate in registry['keys']:
            exact(candidate, 'keyId publicKeyPem status validFrom validUntil statusEffectiveAt')
            check(trusted_identifier(candidate['keyId']) and candidate['keyId'] not in seen and candidate['status'] in ('ACTIVE', 'RETIRED', 'REVOKED', 'COMPROMISED'), 'Invalid key history')
            seen.add(candidate['keyId'])
            start = stamp(candidate['validFrom'])
            end = stamp(candidate['validUntil']) if candidate['validUntil'] is not None else None
            effective = stamp(candidate['statusEffectiveAt']) if candidate['statusEffectiveAt'] is not None else None
            check((end is None or end >= start) and (effective is None if candidate['status'] == 'ACTIVE' else effective is not None and start <= effective <= published), 'Invalid key status dates')
            pem = candidate['publicKeyPem']
            check(isinstance(pem, str) and 0 < len(pem) <= 32768 and 'PRIVATE' not in pem, 'Public issuer key required')
            public = serialization.load_pem_public_key(pem.encode('ascii'))
            check(isinstance(public, ec.EllipticCurvePublicKey) and isinstance(public.curve, ec.SECP256R1), 'P-256 issuer key required')
            if candidate['keyId'] == header['kid'] and registry['issuer'] == envelope['issuer']:
                key = candidate, public
                trusted = start <= issued and (end is None or issued <= end) and (candidate['status'] == 'ACTIVE' or candidate['status'] == 'RETIRED' and issued <= effective)
        current = now < expires
        trust = {'status': 'CURRENT_SNAPSHOT' if current else 'STALE_SNAPSHOT', 'publishedAt': registry['publishedAt'], 'expiresAt': registry['nextReviewAt'], 'currentRevocationKnowledge': 'UNAVAILABLE_OFFLINE'}
    mathematics = 'UNKNOWN_KEY'
    if key:
        try:
            signature_der = utils.encode_dss_signature(int.from_bytes(signature[:32], 'big'), int.from_bytes(signature[32:], 'big'))
            key[1].verify(signature_der, (jws['protected'] + '.' + jws['payload']).encode('ascii'), ec.ECDSA(hashes.SHA256()))
            mathematics = 'VALID'
        except InvalidSignature:
            mathematics = 'INVALID'
    return mathematics, key[0]['status'] if key else 'UNKNOWN', trusted, current, trust


def validate_core_membership(core, manifest, artifacts, omissions):
    """Read the known historical inventory; hash/sign its received bytes verbatim."""
    if core is None:
        check(manifest['core']['manifestSha256'] is None, 'Missing declared core manifest linkage')
        return
    check(manifest['core']['manifestSha256'] is not None, 'Undeclared core manifest linkage')
    check(isinstance(core, dict) and type(core.get('manifestVersion')) is int and core['manifestVersion'] == 1 and core.get('proofId') == manifest['proofId'] and isinstance(core.get('evidence'), list) and len(core['evidence']) <= 4000, 'Unsupported or mismatched core manifest')
    seen = set()
    for item in core['evidence']:
        check(isinstance(item, dict) and identifier(item.get('evidenceId')) and item['evidenceId'] not in seen and sha(item.get('sha256')) and type(item.get('byteSize')) is int and item['byteSize'] >= 0, 'Invalid historical core inventory')
        evidence_id = item['evidenceId']; seen.add(evidence_id)
        check(evidence_id in artifacts or evidence_id in omissions, 'Core original silently absent from declared snapshot membership')
        if evidence_id in artifacts:
            artifact = artifacts[evidence_id]
            check(artifact['kind'] == 'CAPTURE_ORIGINAL' and all(artifact[key] == item.get(key) for key in ('sha256', 'byteSize', 'contentType', 'evidenceType')) and artifact['storage']['key'] == item.get('objectKey') and ('objectVersionId' not in item or artifact['storage']['versionId'] == item['objectVersionId']), 'Core original commitment was substituted')


def verify_package(package, names, read, trust_path, now, expected_proof=None, expected_digest=None,
                   expected_organization=None, expected_environment=None, expected_revision=None,
                   expected_core=None, expected_prior=None):
    import rfc8785
    exact(package, 'schema snapshotId organizationId environment proofId revision envelopePath manifestPath timestamp')
    check(package['schema'] == PACKAGE and package['envelopePath'] == ENVELOPE_PATH and package['manifestPath'] == MANIFEST_PATH, 'Unsupported operational package profile')
    check(all(identifier(package[key]) for key in ('snapshotId', 'organizationId', 'proofId')) and package['environment'] in ('live', 'sandbox') and type(package['revision']) is int and package['revision'] > 0, 'Invalid package identity types')
    exact(package['timestamp'], 'state')
    check(package['timestamp']['state'] == 'NOT_PRESENT', 'Unsupported independent timestamp assertion')
    jws_bytes, manifest_bytes = read(ENVELOPE_PATH), read(MANIFEST_PATH)
    check(len(jws_bytes) <= 40000 and len(manifest_bytes) <= 8 * 1024 * 1024, 'Operational profile size limit exceeded')
    jws = json_value(jws_bytes)
    exact(jws, 'protected payload signature')
    envelope_bytes = b64(jws['payload'], 24000)
    envelope = json_value(envelope_bytes)
    exact(envelope, 'profile snapshotId organizationId environment proofId revision manifestPath manifestSha256 issuer issuedAt')
    check(envelope['profile'] == PROFILE and envelope['manifestPath'] == MANIFEST_PATH and sha(envelope['manifestSha256']) and all(identifier(envelope[key]) for key in ('snapshotId', 'organizationId', 'proofId')) and envelope['environment'] in ('live', 'sandbox') and type(envelope['revision']) is int and envelope['revision'] > 0 and isinstance(envelope['issuer'], str) and len(envelope['issuer']) <= 300 and re.fullmatch(r'https://[A-Za-z0-9.-]+(?:/[A-Za-z0-9_./-]*)?', envelope['issuer']), 'Invalid operational envelope')
    check(rfc8785.dumps(envelope) == envelope_bytes and stamp(envelope['issuedAt']) <= now, 'Future or noncanonical operational envelope')
    manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
    check(manifest_sha == envelope['manifestSha256'], 'Operational manifest digest mismatch')
    manifest = json_value(manifest_bytes)
    artifacts, omissions = validate_manifest(manifest)
    check(rfc8785.dumps(manifest) == manifest_bytes, 'Noncanonical operational manifest')
    for key in ('snapshotId', 'organizationId', 'environment', 'proofId', 'revision'):
        check(package[key] == envelope[key] == manifest[key], 'Operational package identity mismatch')
    check(stamp(manifest['evaluation']['at']) <= stamp(envelope['issuedAt']), 'Snapshot issued before frozen evaluation')
    for actual, required in [(manifest['proofId'], expected_proof), (manifest_sha, expected_digest.lower() if expected_digest else None), (manifest['organizationId'], expected_organization), (manifest['environment'], expected_environment), (manifest['revision'], expected_revision), (manifest['core']['manifestSha256'], expected_core.lower() if expected_core else None), (manifest['priorSnapshot']['manifestSha256'] if manifest['priorSnapshot'] else None, expected_prior.lower() if expected_prior else None)]:
        check(required is None or actual == required, 'Independently required operational linkage mismatch')
    reserved = {'package.json', ENVELOPE_PATH, MANIFEST_PATH}
    core = None
    if manifest['core']['manifestSha256'] is not None:
        core_bytes = read(CORE_PATH)
        check(len(core_bytes) <= 8 * 1024 * 1024 and hashlib.sha256(core_bytes).hexdigest() == manifest['core']['manifestSha256'], 'Core manifest linkage mismatch')
        core = json_value(core_bytes)
        reserved.add(CORE_PATH)
    validate_core_membership(core, manifest, artifacts, omissions)
    if manifest['priorSnapshot'] is not None:
        prior_bytes = read(PRIOR_PATH)
        check(len(prior_bytes) <= 8 * 1024 * 1024 and hashlib.sha256(prior_bytes).hexdigest() == manifest['priorSnapshot']['manifestSha256'], 'Prior snapshot digest mismatch')
        prior = json_value(prior_bytes)
        prior_artifacts, prior_omissions = validate_manifest(prior)
        validate_core_membership(None if prior['core']['manifestSha256'] is None else core, prior, prior_artifacts, prior_omissions)
        check(rfc8785.dumps(prior) == prior_bytes and prior['snapshotId'] == manifest['priorSnapshot']['snapshotId'] and all(prior[key] == manifest[key] for key in ('organizationId', 'environment', 'proofId')) and prior['revision'] < manifest['revision'] and (prior['core']['manifestSha256'] is None or prior['core'] == manifest['core']) and stamp(prior['evaluation']['at']) <= stamp(manifest['evaluation']['at']), 'Prior snapshot tenant, revision or core linkage mismatch')
        reserved.add(PRIOR_PATH)
    check(not (set(names) - reserved - {artifact['path'] for artifact in artifacts.values()}), 'Undeclared operational package entries')
    files, missing, modified = [], [], []
    for artifact in artifacts.values():
        path = artifact['path']
        data = read(path) if path in names else None
        matched = data is not None and len(data) == artifact['byteSize'] and hashlib.sha256(data).hexdigest() == artifact['sha256']
        if data is None:
            missing.append(path)
        elif not matched:
            modified.append(path)
        files.append({'path': path, 'kind': artifact['kind'], 'status': 'MISSING' if data is None else 'HASH_MATCHED' if matched else 'HASH_MISMATCH', 'sha256': artifact['sha256'], 'expectedByteSize': artifact['byteSize'], 'actualByteSize': len(data) if data is not None else None})
    mathematics, key_status, trusted, current, trust = verify_signature(jws, envelope, trust_path, now)
    hash_integrity = 'FAIL' if modified else 'INCOMPLETE' if missing else 'PASS'
    coverage = 'UNKNOWN' if mathematics != 'VALID' else 'PARTIAL' if missing or modified or omissions else 'COMPLETE_FOR_DECLARED_SCOPE'
    verified = mathematics == 'VALID' and hash_integrity == 'PASS' and coverage == 'COMPLETE_FOR_DECLARED_SCOPE' and trusted and current
    return {'status': 'VERIFIED' if verified else 'INTEGRITY_INCOMPLETE', 'profile': PROFILE, 'proofId': manifest['proofId'], 'snapshotId': manifest['snapshotId'], 'recordType': 'OPERATIONAL_SNAPSHOT', 'recordId': manifest['snapshotId'], 'organizationId': manifest['organizationId'], 'environment': manifest['environment'], 'revision': manifest['revision'], 'priorSnapshot': manifest['priorSnapshot'], 'manifestSha256': manifest_sha, 'coreManifestSha256': manifest['core']['manifestSha256'], 'coreCapture': 'NOT_PRESENT' if core is None else 'PRESENT', 'evaluation': manifest['evaluation'], 'assertion': manifest['assertion'], 'issuer': envelope['issuer'], 'issuedAt': envelope['issuedAt'], 'hashIntegrity': hash_integrity, 'issuerSignature': mathematics, 'coverage': coverage, 'operationalCoverage': 'FROZEN_DECLARED_REVISION', 'keyStatus': key_status, 'keyTrustedAtIssue': trusted, 'signatureVerified': mathematics == 'VALID', 'timestamp': 'NOT_PRESENT', 'truthOfRecordedScene': 'NOT_ASSESSED', 'trust': trust, 'files': files, 'missing': missing, 'modified': modified, 'omissions': list(omissions.values()), 'evidenceVerified': len(artifacts) - len(missing) - len(modified), 'limitations': ['Operational values and reviews are organization-submitted assertions, not independent physical verification.', 'The received revision and prior linkage cannot rule out unseen later snapshots or operational additions.', 'Requirement evaluation is recomputed from the signed declared evidence, times, types, links and waivers; source assertions remain unverified physical claims.', 'Storage version commitments do not constitute a live preservation or retention audit.', 'Issuer time is not an independent timestamp. Current revocation knowledge is unavailable offline.', 'Archive-included keys never establish trust.']}
