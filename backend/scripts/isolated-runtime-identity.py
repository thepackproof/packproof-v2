"""Real Cognito MFA -> private TLS API acceptance. Tokens and seeds stay in memory."""
import datetime
import hashlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import secrets
import socket
import ssl
import subprocess
import sys
import time
import zipfile
import boto3
from botocore.config import Config

spec = importlib.util.spec_from_file_location('identity_helpers', Path(__file__).with_name('isolated-identity-acceptance.py'))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
assert os.environ.get('PACKPROOF_TEST_PURPOSE') == 'isolated-m1-synthetic'
assert os.environ['RUNTIME_CLUSTER'] == 'packproof-m1-20261021-runtime'
pool, app = os.environ['ISOLATED_USER_POOL_ID'], os.environ['ISOLATED_CLIENT_ID']
assert pool == 'us-east-1_1wLVqaizj'
region = 'us-east-1'
cognito, ecs, s3 = (boto3.client(x, region_name=region, config=Config(connect_timeout=10, read_timeout=30, retries={'mode': 'standard', 'max_attempts': 3})) for x in ['cognito-idp', 'ecs', 's3'])
created, tokens, users, tasks = [], {}, {}, {}
report = {'schema': 'packproof.isolated-runtime-acceptance.v1', 'source': os.environ['CANDIDATE_SHA'],
          'buildId': os.environ['CODEBUILD_BUILD_ID'], 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'checks': [], 'limits': ['Synthetic identities in the isolated Cognito pool; no real person/device enrollment.',
                                  'The synthetic developer email is admin-set only in this isolated pool; no email is sent.',
                                  'This run does not authorize production or substitute for independent release review.']}
phase, response_status, response_code = 'discover_services', None, None
last_request = None


def passed(name, **facts):
    report['checks'].append({'name': name, 'passed': True, **facts})
    print(json.dumps({'event': 'runtime_acceptance_check', 'name': name}), flush=True)


try:
    for kind in ['api', 'worker']:
        arns = ecs.list_tasks(cluster=os.environ['RUNTIME_CLUSTER'], serviceName='packproof-m1-20261021-runtime-' + kind, desiredStatus='RUNNING')['taskArns']
        assert len(arns) == 1
        task = ecs.describe_tasks(cluster=os.environ['RUNTIME_CLUSTER'], tasks=arns)['tasks'][0]
        assert task['lastStatus'] == 'RUNNING' and task['healthStatus'] == 'HEALTHY'
        tasks[kind] = task
    assert tasks['api']['taskArn'] != tasks['worker']['taskArn']
    ip = next(d['value'] for a in tasks['api']['attachments'] for d in a['details'] if d['name'] == 'privateIPv4Address')
    assert ip.startswith('10.42.')
    report['tasks'] = {kind: {'taskArn': t['taskArn'], 'taskDefinitionArn': t['taskDefinitionArn'],
                            'imageDigest': t['containers'][0]['imageDigest'], 'healthStatus': t['healthStatus']} for kind, t in tasks.items()}
    passed('separate_healthy_private_fargate_tasks')
    bucket = 'packproof-m1-20261020-uploadbucket-8o4ikwomdg8h'
    with s3.get_object(Bucket=bucket, Key='acceptance/runtime/config/tls-ca.pem')['Body'] as body:
        ca = body.read().decode()
    context = ssl.create_default_context(cadata=ca)

    class PrivateConnection(http.client.HTTPSConnection):
        receive_buffer = None

        def connect(self):
            connection = socket.create_connection((ip, 3443), timeout=30)
            if self.receive_buffer:
                connection.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, self.receive_buffer)
            self.sock = context.wrap_socket(connection, server_hostname='packproof-m1.test')

    def queue_probe(mode, webhook_id, run_id):
        key = 'acceptance/runtime/probes/worker/queued-' + run_id + '-' + mode + '.json'
        launched = ecs.run_task(
            cluster=os.environ['RUNTIME_CLUSTER'], taskDefinition=tasks['worker']['taskDefinitionArn'],
            launchType='FARGATE', platformVersion=tasks['worker']['platformVersion'], count=1,
            startedBy='queued-revocation-' + mode,
            networkConfiguration={'awsvpcConfiguration': {
                'subnets': ['subnet-00ce0618188c68de8', 'subnet-0be41abd945430b4d'],
                'securityGroups': [os.environ['ISOLATED_SERVICE_SECURITY_GROUP']], 'assignPublicIp': 'DISABLED'}},
            overrides={'containerOverrides': [{'name': 'worker',
                'command': ['node', 'scripts/isolated-runtime-queued-revocation.mjs'],
                'environment': [{'name': name, 'value': value} for name, value in {
                    'REVOCATION_MODE': mode, 'REVOCATION_WEBHOOK_ID': webhook_id,
                    'REVOCATION_REPORT_KEY': key}.items()]}]})
        assert not launched.get('failures') and len(launched.get('tasks', [])) == 1
        task_arn, stopped = launched['tasks'][0]['taskArn'], False
        try:
            deadline = time.monotonic() + 300
            while time.monotonic() < deadline:
                observed = ecs.describe_tasks(cluster=os.environ['RUNTIME_CLUSTER'], tasks=[task_arn])['tasks'][0]
                if observed['lastStatus'] == 'STOPPED':
                    stopped = True
                    worker = next(c for c in observed['containers'] if c['name'] == 'worker')
                    assert worker.get('exitCode') == 0, 'Queued revocation worker failed'
                    with s3.get_object(Bucket=bucket, Key=key)['Body'] as body:
                        result = json.loads(body.read())
                    assert result['taskArn'] == task_arn and result['source'] == os.environ['CANDIDATE_SHA']
                    assert result['status'] == 'PASSED' and result['transportCalls'] == 0
                    return result
                time.sleep(3)
            raise TimeoutError('Queued revocation worker did not stop')
        finally:
            if not stopped:
                ecs.stop_task(cluster=os.environ['RUNTIME_CLUSTER'], task=task_arn, reason='Bounded acceptance task cleanup')

    def request(method, path, actor=None, body=None, expect=200, headers=None, attempt=0):
        global response_status, response_code, last_request
        last_request = {'method': method, 'path': path}
        connection = PrivateConnection('packproof-m1.test', 3443, context=context, timeout=30)
        h = {'Content-Type': 'application/json', 'Idempotency-Key': secrets.token_hex(16)}
        if actor:
            h['Authorization'] = 'Bearer ' + tokens.get(actor, actor)
        h.update(headers or {})
        try:
            connection.request(method, path, None if body is None else json.dumps(body), h)
            response = connection.getresponse()
            data = response.read()
            value = json.loads(data) if data else {}
            response_status = response.status
            response_code = (value.get('code') or value.get('error', {}).get('code')) if isinstance(value, dict) else None
            last_request['operationId'] = response.getheader('X-PackProof-Operation-Id')
            if response.status == 503 and response_code == 'POLICY_DURABILITY_PENDING' and attempt < 60:
                connection.close()
                time.sleep(1)
                return request(method, path, actor, body, expect, h, attempt + 1)
            assert response.status in (expect if isinstance(expect, tuple) else (expect,)), 'Unexpected HTTP response'
            return value, {key.lower(): value for key, value in response.getheaders()}
        finally:
            connection.close()

    phase = 'tls_readiness_and_authentication'
    assert request('GET', '/ready')[0]['status'] == 'ready'
    request('GET', '/me', expect=401)
    request('GET', '/me', 'not-a-jwt', expect=401)
    passed('pinned_tls_readiness_and_unauthenticated_denial')
    phase = 'cognito_mfa'
    for actor in ['developer', 'ownerA', 'ownerB', 'operatorA', 'operatorB', 'operatorC']:
        username, password = 'm1-runtime-' + secrets.token_hex(8), 'Aa1!' + secrets.token_urlsafe(32)
        attributes = [{'Name': 'email', 'Value': 'admin@thepackproof.com'}, {'Name': 'email_verified', 'Value': 'true'}] if actor == 'developer' else []
        cognito.admin_create_user(UserPoolId=pool, Username=username, MessageAction='SUPPRESS', UserAttributes=attributes)
        created.append(username)
        cognito.admin_set_user_password(UserPoolId=pool, Username=username, Password=password, Permanent=True)
        first = cognito.admin_initiate_auth(UserPoolId=pool, ClientId=app, AuthFlow='ADMIN_USER_PASSWORD_AUTH', AuthParameters={'USERNAME': username, 'PASSWORD': password})
        assert first['ChallengeName'] == 'MFA_SETUP' and 'AuthenticationResult' not in first
        association = cognito.associate_software_token(Session=first['Session'])
        verified = cognito.verify_software_token(Session=association['Session'], UserCode=helpers.totp(association['SecretCode']))
        assert verified['Status'] == 'SUCCESS'
        authenticated = cognito.admin_respond_to_auth_challenge(UserPoolId=pool, ClientId=app, ChallengeName='MFA_SETUP', Session=verified['Session'], ChallengeResponses={'USERNAME': username})
        tokens[actor] = authenticated['AuthenticationResult']['IdToken']
        users[actor] = request('GET', '/me', actor)[0]['userId']
        passed('cognito_mfa_api_identity_' + actor)
    assert len(set(users.values())) == 6
    report['userIds'] = users
    phase = 'organization_authority'
    org = '/me/organizations'
    request('POST', org, 'ownerA', {'kind': 'MERCHANT', 'name': 'Forbidden'}, expect=403)
    merchants = {}
    for actor in ['ownerA', 'ownerB']:
        merchants[actor] = request('POST', org, 'developer', {'kind': 'MERCHANT', 'name': 'Synthetic ' + actor, 'ownerUserId': users[actor]})[0]['id']
    partner = request('POST', org, 'developer', {'kind': 'PARTNER', 'name': 'Synthetic partner'})[0]['id']
    for organization in [*merchants.values(), partner]:
        request('POST', org + '/' + organization + '/entitlement', 'developer', {'enabled': True})
    request('GET', org + '/' + merchants['ownerA'] + '/administration', 'ownerB', expect=(403, 404))
    request('POST', org + '/' + merchants['ownerB'] + '/entitlement', 'ownerB', {'enabled': True}, expect=403)
    passed('merchant_owner_and_developer_boundaries')
    members = {}
    for actor in ['operatorA', 'operatorB', 'operatorC']:
        members[actor] = request('POST', org + '/' + partner + '/memberships', 'developer', {'userId': users[actor], 'role': 'OPERATOR'})[0]['id']
    scopes = ['proofs:read', 'proofs:write', 'capture:request', 'exports:read', 'events:read', 'webhooks:manage']
    expiry = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)).isoformat()
    principal = request('POST', org + '/' + partner + '/service-principals', 'developer', {'name': 'Synthetic receiver'})[0]['id']
    credential = request('POST', org + '/' + partner + '/service-principals/' + principal + '/credentials', 'developer', {'scopes': scopes, 'expiresAt': expiry})[0]
    tokens['partner'] = credential['token']
    grants, integrations, proofs = {}, {}, {}
    account_namespace = 'synthetic-' + secrets.token_hex(8)
    for actor, operator in [('ownerA', 'operatorA'), ('ownerB', 'operatorB')]:
        merchant = merchants[actor]
        permitted = [users[operator]] + ([users['operatorC']] if actor == 'ownerA' else [])
        grants[actor] = request('POST', org + '/' + merchant + '/delegations', actor, {'partnerOrganizationId': partner, 'scopes': scopes, 'operatorUserIds': permitted, 'expiresAt': expiry})[0]['id']
        integrations[actor] = request('POST', org + '/' + merchant + '/integration-accounts', actor, {'provider': 'reference', 'externalAccountId': account_namespace + '-' + actor})[0]['id']
        headers = {'PackProof-Merchant-Id': merchant, 'PackProof-Delegation-Id': grants[actor], 'Idempotency-Key': secrets.token_hex(16)}
        body = {'integrationAccountId': integrations[actor], 'externalId': 'COLLIDING-ORDER-1', 'operatorMembershipId': members[operator], 'transaction': {'itemTitle': 'Synthetic ' + actor, 'quantity': 1}}
        value, _ = request('POST', '/v1/partner/proofs', 'partner', body, 201, headers)
        proofs[actor] = value['proofId']
        replay, replay_headers = request('POST', '/v1/partner/proofs', 'partner', body, 201, headers)
        assert replay['proofId'] == value['proofId'] and replay_headers.get('idempotency-replayed') == 'true'
    assert proofs['ownerA'] != proofs['ownerB']
    conflict, _ = request('POST', org + '/' + merchants['ownerB'] + '/integration-accounts', 'ownerB', {'provider': 'reference', 'externalAccountId': account_namespace + '-ownerA'}, expect=409)
    assert conflict['code'] == 'INTEGRATION_ACCOUNT_CONFLICT'
    passed('integration_namespace_conflict_is_explicit_and_does_not_transfer_ownership')
    passed('colliding_order_ids_stay_separate_and_retries_replay')
    headersA = {'PackProof-Merchant-Id': merchants['ownerA'], 'PackProof-Delegation-Id': grants['ownerA']}
    webhook = request('POST', '/v1/partner/webhooks', 'partner',
                      {'url': 'https://thepackproof.com/api/ready', 'eventTypes': ['proof.finalized', 'evidence.committed']},
                      201, headersA)[0]['id']
    phase = 'capture_finalize_export'
    last_request, response_status, response_code = None, None, None
    captured = subprocess.run(['node', '--import', 'tsx', 'scripts/isolated-runtime-capture.mjs'],
                              input=json.dumps({'ip': ip, 'ca': ca, 'tokens': tokens, 'proofs': proofs, 'merchants': merchants, 'grants': grants, 'integrations': integrations, 'members': members}),
                              text=True, capture_output=True, timeout=240)
    capture_report = json.loads(Path('runtime-artifacts/capture-acceptance.json').read_text())
    report['capture'] = capture_report
    assert captured.returncode == 0 and capture_report['status'] == 'PASSED'
    passed('two_merchant_capture_finalize_and_export_over_https')
    phase = 'partner_scoping_and_revocation'
    headersA = {'PackProof-Merchant-Id': merchants['ownerA'], 'PackProof-Delegation-Id': grants['ownerA']}
    request('GET', '/v1/partner/proofs/' + proofs['ownerB'], 'partner', expect=(403, 404), headers=headersA)
    request('GET', '/v1/partner/event-stream', 'partner', headers=headersA)
    request('GET', '/me/organizations', 'partner', expect=401)
    passed('partner_scope_capture_intent_events_and_personal_auth_boundary')
    phase = 'queued_and_streaming_revocation'
    run_id = secrets.token_hex(16)
    report['queuedBeforeRevocation'] = queue_probe('enqueue', webhook, run_id)
    # Hold a real download open before revocation. The synthetic free atom is
    # larger than the bounded receive window and proxy/kernel buffers.
    streaming = PrivateConnection('packproof-m1.test', 3443, context=context, timeout=30)
    streaming.receive_buffer = 32768
    received, ended_cleanly, aborted = bytearray(), False, None
    try:
        streaming.request('GET', '/v1/partner/proofs/' + proofs['ownerA'] + '/package',
                          headers={'Authorization': 'Bearer ' + tokens['partner'], **headersA})
        response = streaming.getresponse()
        assert response.status == 200
        received.extend(response.read(1))
        assert len(received) == 1
        request('POST', org + '/' + merchants['ownerA'] + '/delegations/' + grants['ownerA'] + '/revoke', 'ownerA', {})
        deadline = time.monotonic() + 90
        try:
            while time.monotonic() < deadline:
                chunk = response.read(65536)
                if not chunk:
                    ended_cleanly = True
                    break
                received.extend(chunk)
            else:
                raise TimeoutError('Revoked stream did not end within acceptance bound')
        except http.client.IncompleteRead as error:
            received.extend(error.partial)
            aborted = type(error).__name__
        except (ConnectionResetError, http.client.RemoteDisconnected) as error:
            aborted = type(error).__name__
        proof = capture_report['proofs'][0]
        assert aborted and not ended_cleanly and len(received) < proof['packageBytes']
        assert not zipfile.is_zipfile(io.BytesIO(received))
        passed('revocation_aborts_existing_export_stream', bytesReceived=len(received),
               completePackageBytes=proof['packageBytes'], termination=aborted)
    finally:
        streaming.close()
    assert request('GET', '/ready')[0]['status'] == 'ready'
    report['queuedAfterRevocation'] = queue_probe('dispatch', webhook, run_id)
    passed('revocation_blocks_already_queued_delivery_in_actual_worker',
           queued=len(report['queuedBeforeRevocation']['after']), transportCalls=0)
    pending = capture_report['interruptedCapture']
    denied, _ = request('POST', '/proofs/' + pending['proofId'] + '/capture-sessions/' + pending['captureId'] + '/complete', 'operatorC', pending['registration'], expect=403)
    assert denied['error']['code'] == 'ORGANIZATION_ACCESS_REVOKED'
    assert hashlib.sha256(Path('runtime-artifacts/interrupted-original.mp4').read_bytes()).hexdigest() == pending['registration']['sha256']
    passed('revocation_denies_open_capture_resume_and_preserves_synthetic_original')
    revoked, _ = request('GET', '/v1/partner/proofs/' + proofs['ownerA'], 'partner', expect=(401, 403, 404), headers=headersA)
    assert (revoked.get('code') or revoked.get('error', {}).get('code')) in ('MERCHANT_NOT_FOUND', 'ORGANIZATION_ACCESS_REVOKED', 'PARTNER_UNAUTHORIZED')
    # Organization ownership does not fabricate a human contributor association.
    request('GET', '/proofs/' + proofs['ownerA'], 'ownerA', expect=403)
    merchant_principal = request('POST', org + '/' + merchants['ownerA'] + '/service-principals', 'ownerA', {'name': 'Synthetic merchant reader'})[0]['id']
    merchant_credential = request('POST', org + '/' + merchants['ownerA'] + '/service-principals/' + merchant_principal + '/credentials', 'ownerA', {'scopes': ['proofs:read', 'exports:read'], 'expiresAt': expiry})[0]
    tokens['merchantReader'] = merchant_credential['token']
    request('GET', '/v1/partner/proofs/' + proofs['ownerA'], 'merchantReader', headers={'PackProof-Merchant-Id': merchants['ownerA']})
    retained = PrivateConnection('packproof-m1.test', 3443, context=context, timeout=30)
    try:
        retained.request('GET', '/v1/partner/proofs/' + proofs['ownerA'] + '/package', headers={
            'Authorization': 'Bearer ' + tokens['merchantReader'], 'PackProof-Merchant-Id': merchants['ownerA']})
        response = retained.getresponse()
        assert response.status == 200
        package = response.read()
        Path('runtime-artifacts/ownerA-after-revocation.pkpr').write_bytes(package)
        with zipfile.ZipFile(io.BytesIO(package)) as archive, zipfile.ZipFile('runtime-artifacts/ownerA.pkpr') as before:
            # Audit supplements can grow; frozen manifest and original media cannot.
            frozen = [name for name in before.namelist() if name == 'manifest.json' or name.startswith('evidence/')]
            assert len(frozen) >= 2
            for name in frozen:
                assert hashlib.sha256(archive.read(name)).digest() == hashlib.sha256(before.read(name)).digest()
        passed('merchant_export_after_partner_revocation_preserves_frozen_manifest_and_original', frozenEntries=len(frozen))
    finally:
        retained.close()
    request('POST', org + '/' + merchants['ownerA'] + '/credentials/' + merchant_credential['id'] + '/revoke', 'ownerA', {})
    headersB = {'PackProof-Merchant-Id': merchants['ownerB'], 'PackProof-Delegation-Id': grants['ownerB']}
    request('GET', '/v1/partner/proofs/' + proofs['ownerB'], 'partner', headers=headersB)
    passed('delegation_revocation_denies_one_merchant_without_affecting_other')
    request('POST', org + '/' + partner + '/credentials/' + credential['id'] + '/revoke', 'developer', {})
    request('GET', '/v1/partner/proofs/' + proofs['ownerB'], 'partner', expect=(401, 403), headers=headersB)
    passed('credential_revocation_denies_remaining_access')
    report.update(status='PASSED', merchants=merchants, partner=partner, proofs=proofs)
except Exception as error:
    report['status'] = 'FAILED'
    report['failure'] = {'phase': phase, 'type': type(error).__name__, 'httpStatus': response_status, 'apiCode': response_code, 'request': last_request}
    if hasattr(error, 'response'):
        report['failure']['awsCode'] = error.response.get('Error', {}).get('Code')
finally:
    cleanup = []
    for username in created:
        try:
            cognito.admin_user_global_sign_out(UserPoolId=pool, Username=username)
            cognito.admin_delete_user(UserPoolId=pool, Username=username)
        except Exception as error:
            cleanup.append(type(error).__name__)
    report['syntheticUsersRemoved'] = len(created) if not cleanup else None
    if cleanup:
        report['status'] = 'FAILED_CLEANUP'
        report['cleanupErrors'] = cleanup
    Path('runtime-artifacts').mkdir(exist_ok=True)
    Path('runtime-artifacts/http-acceptance.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)
sys.exit(0 if report['status'] == 'PASSED' else 1)
