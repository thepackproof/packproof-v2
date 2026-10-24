"""Cross-language test runner. Keys supplied here are explicitly test trust."""
import base64
import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'verifier'))
from verify import verify, VerificationError

fixture = json.load(sys.stdin)
with tempfile.TemporaryDirectory() as temp:
    package = Path(temp) / 'fixture.pkpr'
    trust = Path(temp) / 'trust.json'
    timestamp_trust = Path(temp) / 'timestamp-trust.json'
    if 'archiveBase64' in fixture:
        package.write_bytes(base64.b64decode(fixture['archiveBase64'], validate=True))
    else:
        with zipfile.ZipFile(package, 'w', compression=zipfile.ZIP_STORED) as archive:
            for name, data in fixture['files'].items():
                archive.writestr(name, base64.b64decode(data, validate=True))
    if fixture.get('trust') is not None:
        trust.write_text(json.dumps(fixture['trust']), encoding='utf-8')
    if fixture.get('timestampTrust') is not None:
        timestamp_trust.write_text(json.dumps(fixture['timestampTrust']), encoding='utf-8')
    try:
        result = verify(package, envelope_trust_path=trust if fixture.get('trust') is not None else None,
                        now=dt.datetime.fromisoformat(fixture.get('now', '2026-10-22T05:00:00.000Z').replace('Z', '+00:00')),
                        timestamp_trust_path=timestamp_trust if fixture.get('timestampTrust') is not None else None,
                        expected_proof=fixture.get('expectedProof'), expected=fixture.get('expectedDigest'))
    except VerificationError as error:
        result = {'status': error.status, 'message': str(error)}
    print(json.dumps(result))
