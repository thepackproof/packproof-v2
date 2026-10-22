"""Verify exact HTTP acceptance archives using separately retrieved public trust."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import zipfile
import boto3

assert os.environ.get('PACKPROOF_TEST_PURPOSE') == 'isolated-m1-synthetic'
build = os.environ['ISOLATED_HTTP_ARTIFACT_ID']
expected = os.environ['ISOLATED_HTTP_ARCHIVE_SHA256']
assert re.fullmatch(r'[a-f0-9-]{36}', build) and re.fullmatch(r'[a-f0-9]{64}', expected)
result = boto3.client('s3', region_name='us-east-1').get_object(
    Bucket='packproof-m1-20261020-uploadbucket-8o4ikwomdg8h', Key='acceptance/runtime/' + build + '/runtime.zip')
data = result['Body'].read()
assert hashlib.sha256(data).hexdigest() == expected
archive = zipfile.ZipFile(io.BytesIO(data))
http_report = json.loads(archive.read('http-acceptance.json'))
capture = json.loads(archive.read('capture-acceptance.json'))
assert http_report['status'] == 'PASSED' and capture['status'] == 'PASSED'
output = Path('runtime-artifacts')
output.mkdir(exist_ok=True)
reports = []
for owner, proof in zip(['ownerA', 'ownerB'], capture['proofs']):
    name = owner + '.pkpr'
    package = archive.read(name)
    assert hashlib.sha256(package).hexdigest() == proof['packageSha256']
    path = output / name
    path.write_bytes(package)
    checked = subprocess.run([sys.executable, '../verifier/verify.py', str(path),
                              '--trust-list', '../docs/partner-foundation/runtime-public-trust-2026-10-21.json',
                              '--expected-proof-id', proof['proofId'], '--expected-manifest-sha256', proof['manifestSha256']],
                             text=True, capture_output=True, timeout=60)
    verification = json.loads(checked.stdout)
    (output / (owner + '-verification.json')).write_text(json.dumps(verification, indent=2) + '\n')
    assert checked.returncode == 0 and verification['status'] == 'VERIFIED'
    reports.append({'owner': owner, 'proofId': proof['proofId'], 'manifestSha256': proof['manifestSha256'],
                    'packageSha256': proof['packageSha256'], 'verification': verification})
report = {'schema': 'packproof.isolated-runtime-verification.v1', 'source': os.environ['CANDIDATE_SHA'],
          'buildId': os.environ['CODEBUILD_BUILD_ID'], 'acceptanceArchive': {'buildId': build, 'sha256': expected, 'versionId': result.get('VersionId')},
          'publicTrustSource': 'Separate control-plane GetPublicKey for the pinned KMS ARN; committed public PEM outside both packages.',
          'packages': reports, 'status': 'PASSED'}
(output / 'offline-verification.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'event': 'runtime_offline_verification', 'status': 'PASSED', 'packages': len(reports)}))
