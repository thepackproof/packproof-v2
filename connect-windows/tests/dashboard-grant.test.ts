import { expect, it } from 'vitest';
import { allowedDashboardRequest } from '../main/dashboard-grant';

it('restricts human dashboard handoff to the installation facility and supported human requests', () => {
  const api = 'https://test.invalid/api', scope = { organizationId: 'merchant', environment: 'sandbox', locationId: 'east' };
  const query = '?organizationId=merchant&environment=sandbox&locationId=east';
  const proof = api + '/me/records/order-proofs/proof_101/revisions/5';
  const allowed = (url:string,method='GET') => allowedDashboardRequest(url,method,api,scope);
  expect(allowed(proof + '/sources/event_5' + query)).toBe(true);
  expect(allowed(proof + '/packet' + query, 'POST')).toBe(true);
  expect(allowed(api + '/me/records/context?organizationId=merchant&environment=sandbox')).toBe(true);
  expect(allowed(proof + '/packet' + query)).toBe(false);
  expect(allowed(proof.replace('test.invalid','other.invalid') + query)).toBe(false);
  expect(allowed(proof.replace('/me/records','/v1/partner/agent') + query)).toBe(false);
  expect(allowed(proof + query.replace('east','west'))).toBe(false);
  expect(allowed(proof + query + '&organizationId=other')).toBe(false);
  expect(allowed(proof + query.replace('&locationId=east',''))).toBe(false);
});
