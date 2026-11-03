"""Independent RFC 3161 verification: Python/cryptography and OpenSSL, offline.

The archive's validation receipt is a historical claim, never a trust source.
The caller supplies a fresh, independently authenticated TSA trust policy.
"""
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def stamp(value):
    require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', value), 'Invalid trust time')
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00'))


def encoded(value, maximum):
    require(isinstance(value, str) and len(value) <= 4 * ((maximum + 2) // 3), 'Timestamp size limit')
    data = base64.b64decode(value, validate=True)
    require(0 < len(data) <= maximum and base64.b64encode(data).decode('ascii') == value, 'Invalid timestamp encoding')
    return data


def sequence(data):
    # DER framing only; ASN.1/CMS semantics and signatures remain OpenSSL's job.
    require(len(data) >= 2 and data[0] == 0x30 and data[1] != 0x80, 'Invalid DER sequence')
    if data[1] < 0x80:
        require(data[1] + 2 == len(data), 'Trailing DER data')
    else:
        count = data[1] & 0x7f
        require(1 <= count <= 4 and len(data) >= count + 2 and data[2] != 0, 'Invalid DER length')
        size = int.from_bytes(data[2:2 + count], 'big')
        require(size >= 128 and size + 2 + count == len(data), 'Trailing DER data')


def one_line(text, field):
    values = re.findall(r'^' + re.escape(field) + r': ([^\r\n]+)$', text, re.M)
    require(len(values) == 1, 'Ambiguous timestamp field')
    return values[0].strip()


def token_time(value):
    match = re.fullmatch(r'([A-Z][a-z]{2}) +([0-9]{1,2}) ([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,6})? ([0-9]{4}) GMT', value)
    require(match is not None, 'Unsupported token time')
    month, day, hour, minute, second, fraction, year = match.groups()
    months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split()
    require(month in months, 'Invalid token month')
    return dt.datetime(int(year), months.index(month) + 1, int(day), int(hour), int(minute), int(second), int((fraction or '.')[1:].ljust(6, '0')), tzinfo=dt.timezone.utc)


def verify_timestamp(material, jws, trust, now):
    """Return separate timestamp validity; malformed/untrusted material is INVALID."""
    try:
        return _verify(material, jws, trust, now)
    except (ValueError, TypeError, KeyError, AttributeError, OSError, subprocess.SubprocessError):
        return {'state': 'INVALID', 'reason': 'Timestamp, imprint or independent TSA trust could not be verified', 'networkUsed': False}


def _verify(material, jws, trust, now):
    import rfc8785
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.serialization.pkcs7 import load_der_pkcs7_certificates

    require(isinstance(material, dict) and set(material) == {'profile', 'requestBase64', 'responseBase64', 'validation'} and material['profile'] == 'packproof.rfc3161-material.v1', 'Invalid timestamp material')
    # validation is deliberately not consulted for a successful result.
    request, response = encoded(material['requestBase64'], 4096), encoded(material['responseBase64'], 512 * 1024)
    sequence(request)
    sequence(response)
    require(isinstance(trust, dict) and trust.get('schema') == 'packproof.timestamp-trust.v1', 'Independent TSA trust required')
    policy = trust['policyOid']
    require(isinstance(policy, str) and len(policy) <= 160 and re.fullmatch(r'[012]\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){1,18}', policy), 'Invalid TSA policy')
    require(stamp(trust['reviewedAt']) <= now < stamp(trust['nextReviewAt']), 'Stale TSA trust')
    roots, signers, revoked = trust['roots'], trust['signerSha256'], trust['revokedCertificateSha256']
    require(isinstance(roots, list) and 0 < len(roots) <= 10 and isinstance(signers, list) and 0 < len(signers) <= 100 and isinstance(revoked, list) and len(revoked) <= 1000, 'Invalid trust scope')
    require(all(isinstance(h, str) and re.fullmatch('[a-f0-9]{64}', h) for h in signers + revoked), 'Invalid certificate pin')
    root_pems = []
    for root in roots:
        pem = root['certificatePem']
        require(isinstance(pem, str) and len(pem) <= 32768 and 'PRIVATE' not in pem, 'Invalid root')
        cert = x509.load_pem_x509_certificate(pem.encode('ascii'))
        try:
            require(cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca, 'CA root required')
        except x509.ExtensionNotFound as error:
            raise ValueError('CA root required') from error
        digest = sha(cert.public_bytes(serialization.Encoding.DER))
        require(digest == root['sha256'] and digest not in revoked, 'Root pin mismatch')
        root_pems.append(cert.public_bytes(serialization.Encoding.PEM))
    require(isinstance(jws, dict) and set(jws) == {'protected', 'payload', 'signature'}, 'Invalid JWS')
    imprint = sha(rfc8785.dumps(jws))
    with tempfile.TemporaryDirectory(prefix='packproof-ts-') as directory:
        path = Path(directory)
        for name, data in [('request.tsq', request), ('response.tsr', response), ('roots.pem', b'\n'.join(root_pems)), ('openssl.cnf', b'')]:
            (path / name).write_bytes(data)
        env = {k: os.environ[k] for k in ('PATH', 'SystemRoot') if k in os.environ}
        env.update({'LC_ALL': 'C', 'OPENSSL_CONF': str(path / 'openssl.cnf')})

        def run(*arguments):
            # Write bounded tool output to files, not an unbounded capture pipe.
            with (path / 'stdout').open('wb') as out, (path / 'stderr').open('wb') as err:
                done = subprocess.run(['openssl', *arguments], cwd=path, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err, timeout=10, check=False)
            require(done.returncode == 0 and (path / 'stdout').stat().st_size <= 65536 and (path / 'stderr').stat().st_size <= 65536, 'OpenSSL timestamp verification failed')
            return (path / 'stdout').read_text(encoding='utf-8')

        description = run('ts', '-reply', '-in', 'response.tsr', '-text')
        require(one_line(description, 'Status') in ('Granted.', 'Granted with modifications.'), 'TSA rejected request')
        require(one_line(description, 'Hash Algorithm') == 'sha256' and one_line(description, 'Policy OID') == policy, 'Unsupported imprint or policy')
        generated = token_time(one_line(description, 'Time stamp'))
        require(generated <= now, 'Future timestamp')
        query = run('ts', '-query', '-in', 'request.tsq', '-text')
        require(one_line(query, 'Hash Algorithm') == 'sha256' and one_line(query, 'Policy OID') == policy and re.fullmatch(r'0x[4-7][0-9A-Fa-f]{31}', one_line(query, 'Nonce')), 'Invalid request binding')
        run('ts', '-reply', '-in', 'response.tsr', '-token_out', '-out', 'token.der')
        require(0 < (path / 'token.der').stat().st_size <= 512 * 1024, 'Invalid token length')
        certificates = load_der_pkcs7_certificates((path / 'token.der').read_bytes())
        require(0 < len(certificates) <= 10, 'Invalid certificate count')
        hashes = [sha(cert.public_bytes(serialization.Encoding.DER)) for cert in certificates]
        require(not any(h in revoked for h in hashes), 'Revoked certificate')
        # -noverify here skips path validation only. The next ts commands enforce
        # the explicit root path plus ESS/EKU. CMS identifies the actual signer.
        run('cms', '-verify', '-inform', 'DER', '-in', 'token.der', '-binary', '-noverify', '-signer', 'signer.pem', '-out', 'content.der')
        signer_bytes = (path / 'signer.pem').read_bytes()
        require(len(signer_bytes) <= 32768 and signer_bytes.count(b'BEGIN CERTIFICATE') == 1, 'Exactly one TSA signer required')
        signer = x509.load_pem_x509_certificate(signer_bytes)
        require(sha(signer.public_bytes(serialization.Encoding.DER)) in signers, 'Untrusted TSA signer')
        common = ['ts', '-verify', '-in', 'response.tsr', '-CAfile', 'roots.pem', '-attime', str(int(generated.timestamp())), '-auth_level', '2', '-verify_depth', '8']
        run(*common, '-queryfile', 'request.tsq')
        run(*common, '-digest', imprint)
    return {'state': 'VALID', 'messageImprintAlgorithm': 'SHA-256', 'messageImprint': imprint, 'generatedAt': generated.isoformat(timespec='milliseconds').replace('+00:00', 'Z'), 'requestSha256': sha(request), 'responseSha256': sha(response), 'policyOid': policy, 'certificateSha256': hashes, 'trustSha256': sha(rfc8785.dumps(trust)), 'revocationKnowledge': 'INDEPENDENT_REVIEW_SNAPSHOT', 'networkUsed': False}
