import request from 'supertest';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {createHarness,createUser,type TestHarness} from './helpers.js';
import {createServerApp} from '../src/server-app.js';
import {BearerUserAdapter} from '../src/auth/adapter.js';
import {bindBillingCustomer} from '../src/billing/usage-ledger.js';
import type {StripeBillingAdapter} from '../src/billing/stripe-adapter.js';
import type {ManifestSigningRuntime} from '../src/integrity/signing-runtime.js';
let h:TestHarness;
beforeAll(async()=>{h=await createHarness();await createUser(h,'billing-boundary-user');},30000);
afterAll(async()=>{await h?.close();});
const server=(extra:object={})=>createServerApp({db:h.db,clock:h.clock,objectStore:h.objectStore,auth:new BearerUserAdapter(h.db),publicBaseUrl:'http://localhost',devAuth:true,...extra});

it('preserves exact webhook bytes before JSON parsing, independently of user authentication',async()=>{
  await bindBillingCustomer(h.db,h.clock,{provider:'stripe',environment:'sandbox',providerAccount:'acct_boundary',customerReference:'cus_boundary',userId:'billing-boundary-user'});
  const verifyAndNormalize=vi.fn(async()=>({eventReference:'evt_boundary',customerReference:'cus_boundary',subjectReference:'pi_boundary',paymentReference:'pi_boundary',kind:'payment_settled' as const,occurredAt:'2026-01-01T00:00:00.000Z',amountMinor:10,currency:'USD' as const}));
  const billing={provider:'stripe',environment:'sandbox',providerAccount:'acct_boundary',verifyAndNormalize} as unknown as StripeBillingAdapter;
  const app=server({billing}),body='{ "id" : "evt_boundary", "order" : [2,1] }\n';
  const result=await request(app).post('/billing/webhooks/stripe').set('Content-Type','application/json').set('Stripe-Signature','signed-header-fixture').send(body);
  expect(result.status).toBe(200);
  expect(verifyAndNormalize).toHaveBeenCalledWith({rawBody:Buffer.from(body),signature:'signed-header-fixture'});
  expect((await request(app).post('/billing/webhooks/stripe').set('Content-Type','application/json').send('x'.repeat(1024*1024+1))).status).toBe(413);
  expect(verifyAndNormalize).toHaveBeenCalledTimes(1);
});

it('leaves billing disabled by default and authenticates account and support routes',async()=>{
  const app=server();
  expect((await request(app).post('/billing/webhooks/stripe').send({})).status).toBe(404);
  expect((await request(app).get('/me/billing/invoices')).status).toBe(401);
  expect((await request(app).get('/me/billing/invoices').set('Authorization','Bearer billing-boundary-user')).body).toMatchObject({enabled:false,invoices:[]});
  expect((await request(app).get('/internal/support/grants')).status).toBe(401);
  expect((await request(app).get('/study/consent')).status).toBe(401);
  expect((await request(app).get('/study/consent').set('Authorization','Bearer billing-boundary-user')).body).toEqual({enabled:false,granted:false});
  expect((await request(app).post('/study/consent').set('Authorization','Bearer billing-boundary-user').send({decision:'grant'})).status).toBe(503);
});

it('serves newly reviewed registry bytes without requiring a signing operation',async()=>{
  let raw='{"snapshot":"first"}';
  const reader=vi.fn(()=>raw);
  const manifestSigning={signedTrustRegistryJson:'stale',readSignedTrustRegistry:reader} as unknown as ManifestSigningRuntime;
  const app=server({manifestSigning});
  expect((await request(app).get('/.well-known/packproof-trust-registry.json')).text).toBe(raw);
  raw='{"snapshot":"revoked"}';
  const updated=await request(app).get('/.well-known/packproof-trust-registry.json');
  expect(updated.status).toBe(200);expect(updated.text).toBe(raw);
  expect(updated.headers['cache-control']).toBe('no-store');expect(reader).toHaveBeenCalledTimes(2);
});
