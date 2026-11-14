import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONNECT_APPROVAL_RETURN_KEY,
  connectApprovalReturnPath,
  rememberConnectApprovalReturn,
  consumeConnectApprovalReturn,
} from '../auth/connect-approval-return';

describe('Connect approval deep-link sign-in return', () => {
  beforeEach(() => sessionStorage.clear());

  it('retains only the exact enrollment approval locator and authorized scope', () => {
    rememberConnectApprovalReturn('/app/records/connect/approve?enrollmentId=enroll-a&organizationId=org-a&environment=sandbox&token=PRIVATE', sessionStorage);
    expect(sessionStorage.getItem(CONNECT_APPROVAL_RETURN_KEY)).toBe('/app/records/connect/approve?enrollmentId=enroll-a&organizationId=org-a&environment=sandbox');
    expect(consumeConnectApprovalReturn(sessionStorage)).toBe('/app/records/connect/approve?enrollmentId=enroll-a&organizationId=org-a&environment=sandbox');
    expect(consumeConnectApprovalReturn(sessionStorage)).toBeNull();
  });

  it('restores installation actions but rejects extraneous authority parameters', () => {
    expect(connectApprovalReturnPath('/app/records/connect/approve?installationId=install-a&action=resume&importId=import-a&redeemSecret=private'))
      .toBe('/app/records/connect/approve?installationId=install-a&importId=import-a&action=resume');
  });

  it('restores the exact source configuration and first-batch locator after signed-out login', () => {
    const destination = '/app/records/connect/approve?installationId=install-a&organizationId=org-a&environment=live&subscriptionId=source-a&configurationRevision=3&initialBatchId=batch-a';
    rememberConnectApprovalReturn(destination + '&redeemSecret=PRIVATE&grantToken=PRIVATE', sessionStorage);
    expect(sessionStorage.getItem(CONNECT_APPROVAL_RETURN_KEY)).toBe(destination);
    // The login form may navigate while authentication is pending. Its return
    // cannot discard the selected source or replace it with installation setup.
    rememberConnectApprovalReturn('/login?next=https://attacker.example', sessionStorage);
    expect(consumeConnectApprovalReturn(sessionStorage)).toBe(destination);
    expect(sessionStorage.getItem(CONNECT_APPROVAL_RETURN_KEY)).toBeNull();
  });

  it('restores first-source approval before a first batch exists', () => {
    const destination = '/app/records/connect/approve?installationId=install-a&subscriptionId=source-a&configurationRevision=1';
    rememberConnectApprovalReturn(destination, sessionStorage);
    expect(consumeConnectApprovalReturn(sessionStorage)).toBe(destination);
  });

  it.each([
    'installationId=install-a&subscriptionId=source-a&subscriptionId=source-b',
    'installationId=install-a&installationId=install-b&subscriptionId=source-a',
    'installationId=install-a&subscriptionId=source-a&configurationRevision=2&configurationRevision=3',
    'installationId=install-a&subscriptionId=source-a&initialBatchId=batch-a&initialBatchId=batch-b',
    'installationId=install-a&subscriptionId=source-a&organizationId=org-a&organizationId=org-b',
    'installationId=install-a&subscriptionId=source-a&environment=live&environment=sandbox',
    'enrollmentId=enroll-a&subscriptionId=source-a',
    'enrollmentId=enroll-a&importId=import-a',
    'installationId=install-a&subscriptionId=source-a&importId=import-a',
    'installationId=install-a&subscriptionId=source-a&action=resume',
    'installationId=install-a&initialBatchId=batch-a',
    'installationId=install-a&configurationRevision=3',
    'subscriptionId=source-a&configurationRevision=3',
    'installationId=install-a&subscriptionId=bad%2Fpath',
    'installationId=install-a&subscriptionId=source-a&initialBatchId=bad%2Fpath',
    'installationId=install-a&subscriptionId=source-a&configurationRevision=0',
    'installationId=install-a&subscriptionId=source-a&configurationRevision=01',
    'installationId=install-a&subscriptionId=source-a&configurationRevision=1.5',
    'installationId=install-a&subscriptionId=source-a&configurationRevision=2147483648',
    'installationId=install-a&subscriptionId=source-a&environment=unexpected',
  ])('rejects an ambiguous or mixed source approval locator: %s', query => {
    expect(connectApprovalReturnPath('/app/records/connect/approve?' + query)).toBeNull();
  });

  it.each([
    '/login',
    '/app/records/connect/approve',
    '/app/records/connect/approve?enrollmentId=enroll-a&installationId=install-a',
    '//attacker.example/app/records/connect/approve?enrollmentId=bad',
    '/app/records/connect/approve?enrollmentId=invalid%2Fpath',
    '/app/records/connect/approve?enrollmentId=enroll-a#token',
    '/app/records/connect/remote-command?enrollmentId=enroll-a',
  ])('rejects non-approval or malformed return: %s', href => {
    expect(connectApprovalReturnPath(href)).toBeNull();
  });

  it('does not overwrite a valid pending connection when navigating to login', () => {
    rememberConnectApprovalReturn('/app/records/connect/approve?enrollmentId=enroll-a', sessionStorage);
    rememberConnectApprovalReturn('/login', sessionStorage);
    expect(consumeConnectApprovalReturn(sessionStorage)).toBe('/app/records/connect/approve?enrollmentId=enroll-a');
  });
});
