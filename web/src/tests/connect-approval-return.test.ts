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
