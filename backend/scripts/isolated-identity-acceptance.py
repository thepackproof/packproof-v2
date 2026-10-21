"""Synthetic Cognito MFA exercise. No passwords, TOTP seeds or tokens leave memory."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import struct
import sys
import time
import boto3
from botocore.exceptions import ClientError


def totp(seed):
    key = base64.b32decode(seed + '=' * ((8 - len(seed) % 8) % 8))
    digest = hmac.new(key, struct.pack('>Q', int(time.time()) // 30), hashlib.sha1).digest()
    offset = digest[-1] & 15
    return str((struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7fffffff) % 1000000).zfill(6)


def main():
    assert os.environ.get('PACKPROOF_TEST_PURPOSE') == 'isolated-m1-synthetic'
    assert os.environ.get('AWS_REGION') == 'us-east-1'
    pool, app = os.environ['ISOLATED_USER_POOL_ID'], os.environ['ISOLATED_CLIENT_ID']
    client = boto3.client('cognito-idp', region_name='us-east-1')
    config = client.describe_user_pool(UserPoolId=pool)['UserPool']
    assert config['Name'] == 'packproof-m1-20261020-identity-users'
    assert config['AdminCreateUserConfig']['AllowAdminCreateUserOnly'] is True
    assert config['MfaConfiguration'] == 'ON'
    mfa = client.get_user_pool_mfa_config(UserPoolId=pool)
    assert mfa['SoftwareTokenMfaConfiguration']['Enabled'] is True
    app_config = client.describe_user_pool_client(UserPoolId=pool, ClientId=app)['UserPoolClient']
    assert app_config['EnableTokenRevocation'] is True
    report = {'schema': 'packproof.isolated-identity-acceptance.v1', 'source': os.environ['CANDIDATE_SHA'],
              'poolId': pool, 'clientId': app, 'checks': [], 'limits': [
                  'Synthetic software-token test; no real person or device enrollment.',
                  'No API service or production identity pool uses this test pool.',
                  'Cognito revocation behavior is not proof of application JWT/session revocation.']}
    username = 'm1-acceptance-' + secrets.token_hex(8)
    password = 'Aa1!' + secrets.token_urlsafe(32)
    created = False
    phase = 'required_configuration'

    def passed(name):
        report['checks'].append({'name': name, 'passed': True})
        print(json.dumps({'event': 'identity_acceptance_check', 'name': name}))

    def login(value=password):
        return client.admin_initiate_auth(UserPoolId=pool, ClientId=app,
                                         AuthFlow='ADMIN_USER_PASSWORD_AUTH',
                                         AuthParameters={'USERNAME': username, 'PASSWORD': value})

    try:
        passed('required_totp_and_admin_only_registration')
        phase = 'registration_denial'
        try:
            client.sign_up(ClientId=app, Username=username, Password=password)
        except client.exceptions.NotAuthorizedException:
            passed('self_registration_denied')
        else:
            raise AssertionError('Self registration unexpectedly succeeded')
        phase = 'synthetic_account'
        client.admin_create_user(UserPoolId=pool, Username=username, MessageAction='SUPPRESS')
        created = True
        client.admin_set_user_password(UserPoolId=pool, Username=username, Password=password, Permanent=True)
        try:
            login('Wrong1!' + secrets.token_urlsafe(24))
        except client.exceptions.NotAuthorizedException:
            passed('incorrect_password_denied')
        else:
            raise AssertionError('Incorrect password was accepted')
        phase = 'mfa_enrollment'
        first = login()
        assert first['ChallengeName'] == 'MFA_SETUP' and 'AuthenticationResult' not in first
        passed('password_alone_does_not_issue_tokens')
        association = client.associate_software_token(Session=first['Session'])
        verified = client.verify_software_token(Session=association['Session'],
                                                UserCode=totp(association['SecretCode']))
        assert verified['Status'] == 'SUCCESS'
        enrolled = client.admin_respond_to_auth_challenge(UserPoolId=pool, ClientId=app,
            ChallengeName='MFA_SETUP', Session=verified['Session'], ChallengeResponses={'USERNAME': username})
        assert 'AuthenticationResult' in enrolled
        passed('totp_enrollment_completed')
        phase = 'mfa_challenge'
        client.admin_set_user_mfa_preference(UserPoolId=pool, Username=username,
            SoftwareTokenMfaSettings={'Enabled': True, 'PreferredMfa': True})
        challenge = login()
        assert challenge['ChallengeName'] == 'SOFTWARE_TOKEN_MFA' and 'AuthenticationResult' not in challenge
        passed('subsequent_login_requires_totp')
        incorrect = str((int(totp(association['SecretCode'])) + 1) % 1000000).zfill(6)
        try:
            client.admin_respond_to_auth_challenge(UserPoolId=pool, ClientId=app,
                ChallengeName='SOFTWARE_TOKEN_MFA', Session=challenge['Session'],
                ChallengeResponses={'USERNAME': username, 'SOFTWARE_TOKEN_MFA_CODE': incorrect})
        except client.exceptions.CodeMismatchException:
            passed('incorrect_totp_denied')
        else:
            raise AssertionError('Incorrect TOTP was accepted')
        # Avoid reusing the enrollment code within its time window.
        time.sleep(31 - int(time.time()) % 30)
        challenge = login()
        authenticated = client.admin_respond_to_auth_challenge(UserPoolId=pool, ClientId=app,
            ChallengeName='SOFTWARE_TOKEN_MFA', Session=challenge['Session'],
            ChallengeResponses={'USERNAME': username, 'SOFTWARE_TOKEN_MFA_CODE': totp(association['SecretCode'])})
        token = authenticated['AuthenticationResult']['AccessToken']
        assert client.get_user(AccessToken=token)['Username'] == username
        passed('correct_totp_authenticates')
        phase = 'provider_session_revocation'
        client.admin_user_global_sign_out(UserPoolId=pool, Username=username)
        try:
            client.get_user(AccessToken=token)
        except client.exceptions.NotAuthorizedException:
            passed('signed_out_token_rejected_by_cognito')
        else:
            raise AssertionError('Signed-out token was accepted by Cognito')
        report['status'] = 'PASSED'
    except Exception as error:
        report['status'] = 'FAILED'
        report['failure'] = {'phase': phase, 'code': error.response['Error']['Code'] if isinstance(error, ClientError) else type(error).__name__}
    finally:
        if created:
            try:
                client.admin_delete_user(UserPoolId=pool, Username=username)
                report['syntheticUserRemoved'] = True
            except ClientError as error:
                report['status'] = 'FAILED_CLEANUP'
                report['cleanupError'] = error.response['Error']['Code']
        Path('identity-artifacts').mkdir(exist_ok=True)
        Path('identity-artifacts/identity-acceptance.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    return 0 if report['status'] == 'PASSED' else 1


if __name__ == '__main__':
    sys.exit(main())
