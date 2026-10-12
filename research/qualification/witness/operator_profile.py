"""Offline public enrollment packet checks; never establishes operator independence."""
from __future__ import annotations
import argparse
import base64
import binascii
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

MAX_DOCUMENT_BYTES=65536

def require(condition,code):
    if not condition:raise ValueError(code)

def exact(value,keys,code):
    require(isinstance(value,dict) and set(value)==set(keys),code)

def text(value,code):
    require(isinstance(value,str) and 1<=len(value)<=128 and value==value.strip() and all(ord(c)>=32 for c in value),code)
    return value

def sha256(value,code):
    require(isinstance(value,str) and re.fullmatch('[a-f0-9]{64}',value) is not None,code)
    return value

def timestamp(value):
    require(isinstance(value,str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z',value) is not None,'UTC_TIMESTAMP_REQUIRED')
    try:result=datetime.fromisoformat(value[:-1]+'+00:00')
    except ValueError:raise ValueError('UTC_TIMESTAMP_REQUIRED') from None
    return result

def decode_document(raw):
    def pairs(items):
        result={}
        for key,value in items:
            require(key not in result,'DUPLICATE_JSON_KEY');result[key]=value
        return result
    require(0<len(raw)<=MAX_DOCUMENT_BYTES,'PUBLIC_DOCUMENT_BYTE_LIMIT')
    try:document=json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('NONFINITE_JSON')))
    except (json.JSONDecodeError,UnicodeDecodeError,RecursionError):raise ValueError('INVALID_PUBLIC_DOCUMENT') from None
    pending=[(document,0)]
    while pending:
        value,depth=pending.pop()
        require(depth<=16,'PUBLIC_DOCUMENT_DEPTH_LIMIT')
        children=value.values() if isinstance(value,dict) else value if isinstance(value,list) else ()
        pending.extend((child,depth+1) for child in children)
    return document

def read_document(path):
    with Path(path).open('rb') as stream:raw=stream.read(MAX_DOCUMENT_BYTES+1)
    return raw,decode_document(raw)

def public_key_entry(identifier,entry,at):
    allowed={'keyId','publicKeyPem','operatorId','testOnly','independent','validFrom','validUntil','revoked'}
    required={'keyId','publicKeyPem','operatorId','testOnly','independent','validFrom','validUntil','revoked'}
    require(isinstance(entry,dict) and required<=set(entry)<=allowed,'PUBLIC_KEY_ENTRY_FIELDS')
    sha256(identifier,'PUBLIC_KEY_ID');require(entry['keyId']==identifier,'PUBLIC_KEY_ID_MISMATCH')
    text(entry['operatorId'],'OPERATOR_ID')
    require(all(type(entry[k]) is bool for k in ('testOnly','independent','revoked')),'BOOLEAN_KEY_FLAGS_REQUIRED')
    pem=entry['publicKeyPem']
    require(isinstance(pem,str) and len(pem)<=2048 and pem.strip().startswith('-----BEGIN PUBLIC KEY-----') and 'PRIVATE' not in pem,'PUBLIC_KEY_ONLY')
    # RFC 8410 SPKI: Ed25519 OID, absent parameters, zero unused bits, 32-byte key.
    # This parses the public-key container only; it does not prove key possession.
    lines=pem.strip().splitlines()
    require(len(lines)>=3 and lines[0]=='-----BEGIN PUBLIC KEY-----' and lines[-1]=='-----END PUBLIC KEY-----','PUBLIC_KEY_ONLY')
    try:der=base64.b64decode(''.join(lines[1:-1]),validate=True)
    except (ValueError,binascii.Error):raise ValueError('INVALID_PUBLIC_KEY') from None
    prefix=bytes.fromhex('302a300506032b6570032100')
    require(len(der)==44 and der.startswith(prefix),'ED25519_PUBLIC_KEY_REQUIRED')
    actual=hashlib.sha256(der[len(prefix):]).hexdigest()
    require(actual==identifier,'PUBLIC_KEY_ID_MISMATCH')
    start,end=timestamp(entry['validFrom']),timestamp(entry['validUntil'])
    require(start<end,'KEY_INTERVAL_ORDER')
    return not entry['revoked'] and start<=at<=end

def endpoint(value):
    require(isinstance(value,str) and len(value)<=512,'PUBLIC_HTTPS_ENDPOINT')
    try:parsed=urlsplit(value);port=parsed.port
    except ValueError:raise ValueError('PUBLIC_HTTPS_ENDPOINT') from None
    require(parsed.scheme=='https' and parsed.hostname and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment and port in (None,443),'PUBLIC_HTTPS_ENDPOINT')
    host=parsed.hostname
    require(host!='localhost' and '.' in host and len(host)<=253 and all(re.fullmatch('[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?',label) for label in host.split('.')),'PUBLIC_HTTPS_ENDPOINT')
    try:address=ipaddress.ip_address(host)
    except ValueError:pass
    else:require(address.is_global,'PUBLIC_HTTPS_ENDPOINT')

def validate(policy,packet,policy_bytes,*,at=None):
    require(decode_document(policy_bytes)==policy,'PARSED_POLICY_BYTES_MISMATCH')
    at=at or datetime.now(timezone.utc)
    require(at.tzinfo is not None,'AWARE_VALIDATION_TIME_REQUIRED')
    exact(policy,{'schemaVersion','policyId','logId','testOnly','requiredOperators','logKeys','witnessKeys'},'TRUST_POLICY_FIELDS')
    require(policy['schemaVersion']=='packproof.witness-trust.v1' and policy['testOnly'] is False,'NON_TEST_POLICY_REQUIRED')
    text(policy['policyId'],'POLICY_ID');text(policy['logId'],'LOG_ID')
    required=policy['requiredOperators']
    require(isinstance(required,list) and len(required)==2 and all(isinstance(x,str) for x in required) and len(set(required))==2,'TWO_NAMED_OPERATORS_REQUIRED')
    for operator in required:text(operator,'OPERATOR_ID')
    require(isinstance(policy['logKeys'],dict) and 1<=len(policy['logKeys'])<=8 and isinstance(policy['witnessKeys'],dict) and 2<=len(policy['witnessKeys'])<=16,'BOUNDED_KEY_REGISTRY_REQUIRED')
    require(not set(policy['logKeys'])&set(policy['witnessKeys']),'LOG_WITNESS_KEY_REUSE')
    current={}
    for group in ('logKeys','witnessKeys'):
        for kid,entry in policy[group].items():current[kid]=public_key_entry(kid,entry,at)
    require(any(current[kid] and not entry['testOnly'] for kid,entry in policy['logKeys'].items()),'CURRENT_NON_TEST_LOG_KEY_REQUIRED')
    exact(packet,{'schemaVersion','policySha256','logOrganizationId','operators','independenceReview'},'OPERATOR_PACKET_FIELDS')
    require(packet['schemaVersion']=='packproof.witness-operator-packet.v1','OPERATOR_PACKET_SCHEMA')
    require(sha256(packet['policySha256'],'POLICY_SHA256')==hashlib.sha256(policy_bytes).hexdigest(),'EXACT_POLICY_BYTES_REQUIRED')
    organizations={text(packet['logOrganizationId'],'LOG_ORGANIZATION_ID')};operators=packet['operators']
    require(isinstance(operators,list) and len(operators)==2,'TWO_OPERATOR_PACKETS_REQUIRED')
    seen=set()
    fields={'operatorId','organizationId','publicKeyIds','serviceEndpoint','protocol','checkpointMaxAgeSeconds','retentionDays','incidentContactRole','keyExchangeEvidenceSha256','agreementEvidenceSha256','restoreExerciseEvidenceSha256'}
    for operator in operators:
        exact(operator,fields,'OPERATOR_FIELDS')
        identity=text(operator['operatorId'],'OPERATOR_ID');organization=text(operator['organizationId'],'ORGANIZATION_ID')
        require(identity in required and identity not in seen,'EXACT_REQUIRED_OPERATOR_ROSTER');seen.add(identity)
        require(organization not in organizations,'DISTINCT_DECLARED_ORGANIZATIONS_REQUIRED');organizations.add(organization)
        ids=operator['publicKeyIds']
        require(isinstance(ids,list) and 1<=len(ids)<=8 and all(isinstance(k,str) for k in ids) and len(set(ids))==len(ids),'BOUNDED_OPERATOR_KEY_IDS')
        for kid in ids:
            sha256(kid,'PUBLIC_KEY_ID');entry=policy['witnessKeys'].get(kid)
            require(entry is not None and entry['operatorId']==identity and entry['independent'] is True and entry['testOnly'] is False and current[kid],'CURRENT_ENROLLED_WITNESS_KEY_REQUIRED')
        endpoint(operator['serviceEndpoint'])
        require(operator['protocol']=='packproof-pymerkle-json-v1','REVIEWED_ADAPTER_REQUIRED')
        require(type(operator['checkpointMaxAgeSeconds']) is int and 60<=operator['checkpointMaxAgeSeconds']<=86400,'BOUNDED_FRESHNESS_TARGET_REQUIRED')
        require(type(operator['retentionDays']) is int and 1<=operator['retentionDays']<=36500,'BOUNDED_RETENTION_REQUIRED')
        text(operator['incidentContactRole'],'INCIDENT_CONTACT_ROLE_REQUIRED')
        for key in ('keyExchangeEvidenceSha256','agreementEvidenceSha256','restoreExerciseEvidenceSha256'):sha256(operator[key],'EVIDENCE_DIGEST_REQUIRED')
    review=packet['independenceReview']
    exact(review,{'reviewerRole','evidenceSha256'},'INDEPENDENCE_REVIEW_FIELDS')
    text(review['reviewerRole'],'REVIEWER_ROLE_REQUIRED')
    sha256(review['evidenceSha256'],'REVIEW_EVIDENCE_DIGEST_REQUIRED')
    return {'schemaVersion':'packproof.witness-operator-packet-check.v1','checkedAt':at.isoformat(),'publicPacketValid':True,
            'policySha256':hashlib.sha256(policy_bytes).hexdigest(),'declaredOperatorCount':2,'verifiedIndependentOperatorCount':0,
            'externalEvidenceAuthenticated':False,'endpointReachabilityChecked':False,'qualificationPassed':False,'releaseAuthorized':False,
            'scope':'Offline public structure, key identity and exact-policy binding only. Documentary digests and distinct names do not prove independent control, agreements, service readiness or reviewer approval.'}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--policy',required=True);parser.add_argument('--packet',required=True)
    args=parser.parse_args()
    try:
        raw,policy=read_document(args.policy);_,packet=read_document(args.packet)
        result=validate(policy,packet,raw)
    except (ValueError,OSError,KeyError,TypeError):
        print(json.dumps({'publicPacketValid':False,'failureCode':'PUBLIC_ENROLLMENT_PACKET_REJECTED','qualificationPassed':False,'releaseAuthorized':False}));return 1
    print(json.dumps(result,indent=2));return 0

if __name__=='__main__':raise SystemExit(main())
