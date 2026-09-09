import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHarness, createUser, auth, commitFulfillmentAndAttest, type TestHarness } from './helpers.js';
import { createServerApp } from '../src/server-app.js';
import { BearerUserAdapter } from '../src/auth/adapter.js';
import { createDefaultIntegrationRegistry } from '../src/integrations/registry.js';
import { createTenant, issueApiKey, revokeApiKey } from '../src/platform/tenants.js';
import { createTransaction } from '../src/domain/transactions.js';
import { createOrGetProof } from '../src/domain/create-proof.js';
import { previewDisclosure, createDisclosureGrant } from '../src/domain/disclosure.js';
import { authorizeClaimsProof, revokeClaimsAuthorization } from '../src/platform/claims.js';
import { finalizeProof } from '../src/domain/finalize.js';
import { integrationReadiness } from '../src/operations/integration-readiness.js';

describe('pre-production claims and truthful data boundaries',()=>{
  let h:TestHarness,owner:string,tenantId:string,key:string,keyId:string;
  let now=new Date('2026-09-09T17:00:00Z');const clock={now:()=>new Date(now)};
  beforeAll(async()=>{
    h=await createHarness(clock);owner=await createUser(h);
    tenantId=String((await createTenant(h.db,clock,owner,{name:'Claims test',environment:'sandbox'})).id);
    const issued=await issueApiKey(h.db,clock,owner,tenantId,{name:'Zendesk',scopes:['claims:read']});key=issued.token;keyId=issued.id;
  });
  afterAll(async()=>h.close());
  async function approved(externalId:string,trackingNumber='1Z999AA10123456784'){
    const txn=await createTransaction(h.db,clock,owner,{itemTitle:'Controlled shipment',shipping:{carrier:'UPS',trackingNumber},metadata:{source:'MANUAL',marketplace:'craigslist'}});
    const p=await createOrGetProof(h.db,clock,owner,txn.transactionId);
    await commitFulfillmentAndAttest(h,owner,p.proofId);
    const manifest=await finalizeProof(h.db,clock,owner,p.proofId);
    const input={purpose:'SHARED_PROOF',originalsReviewed:true,expiresAt:new Date(now.getTime()+86400000).toISOString(),publicWebBaseUrl:'https://thepackproof.com'};
    const preview=await previewDisclosure(h.db,owner,p.proofId,input);
    const link=await createDisclosureGrant(h.db,clock,owner,p.proofId,{...input,previewHash:preview.disclosure.viewHash});
    const grant=await authorizeClaimsProof(h.db,clock,owner,tenantId,p.proofId,{externalId,accessLinkId:link.accessLinkId});
    return {proofId:p.proofId,grant,manifest};
  }
  const context={ticketId:'1001',workerId:'2002'};
  it('finds a finalized manual Proof, streams the same reviewed video and audits every viewer open',async()=>{
    const p=await approved('MANUAL-ONE');
    const found=await request(h.app).post('/v1/claims/lookup').set(auth(key)).send({...context,orderId:'MANUAL-ONE'});
    expect(found.status,JSON.stringify(found.body)).toBe(200);
    expect(found.body.result).toBe('FOUND');
    expect(found.body.matches[0].integrity.result).toBe('MANIFEST_HASH_MATCH');
    expect(found.body.requestId).toBe(found.headers['x-packproof-operation-id']);
    expect(JSON.stringify(found.body)).not.toMatch(/objectKey|token_hash|buyer@example|s3\.amazonaws/);
    const opened=await request(h.app).post(`/v1/claims/proofs/${p.proofId}/open`).set(auth(key)).send(context);
    expect(opened.status,JSON.stringify(opened.body)).toBe(201);
    expect(Date.parse(opened.body.expiresAt)-now.getTime()).toBe(900000);
    const token=new URL(opened.body.viewerUrl).pathname.split('/').at(-1);
    const viewer=await request(h.app).get(`/public/proofs/${token}`);
    expect(viewer.status,JSON.stringify(viewer.body)).toBe(200);expect(viewer.body.proofId).toBe(p.proofId);expect(viewer.body.evidence.length).toBe(1);
    expect((await request(h.app).get(`/public/proofs/${token}/evidence/${viewer.body.evidence[0].evidenceId}`)).status).toBe(200);
    await request(h.app).get(`/public/proofs/${token}`);
    const audit=await h.db.query("SELECT * FROM audit_events WHERE proof_id=$1 AND event_type='CLAIMS_PROOF_OPENED'",[p.proofId]);expect(audit.rows.length).toBe(2);
    const repeated=await finalizeProof(h.db,clock,owner,p.proofId);expect(repeated.sha256).toBe(p.manifest.sha256);
    await revokeClaimsAuthorization(h.db,clock,owner,tenantId,p.grant.authorizationId);
    expect((await request(h.app).get(`/public/proofs/${token}`)).status).toBe(404);
  });
  it('never exposes another tenant and refuses to guess when identifiers disagree',async()=>{
    const p=await approved('TENANT-BOUND');
    const other=String((await createTenant(h.db,clock,owner,{name:'Other',environment:'sandbox'})).id);
    const token=(await issueApiKey(h.db,clock,owner,other,{name:'Other key',scopes:['claims:read']})).token;
    const hidden=await request(h.app).post('/v1/claims/lookup').set(auth(token)).send({...context,proofId:p.proofId});expect(hidden.body.result).toBe('NOT_FOUND');
    expect((await request(h.app).post(`/v1/claims/proofs/${p.proofId}/open`).set(auth(token)).send(context)).status).toBe(404);
    const conflict=await request(h.app).post('/v1/claims/lookup').set(auth(key)).send({...context,proofId:p.proofId,trackingNumber:'WRONG'});expect(conflict.body.result).toBe('NOT_FOUND');
    expect((await request(h.app).post('/v1/claims/lookup').set(auth(key)).send({...context,tenantId:other,proofId:p.proofId})).status).toBe(400);
    expect((await request(h.app).post('/v1/claims/lookup').set(auth(owner)).send({...context,proofId:p.proofId})).status).toBe(401);
  });
  it('returns multiple matches without silently selecting a shipment',async()=>{
    await approved('DUPLICATE');await approved('DUPLICATE');
    const response=await request(h.app).post('/v1/claims/lookup').set(auth(key)).send({...context,orderId:'DUPLICATE'});
    expect(response.body.result).toBe('MULTIPLE_MATCHES');expect(response.body.matches.length).toBe(2);
    const events=await h.db.query("SELECT * FROM claims_access_events WHERE operation='LOOKUP' AND result_count=0");expect(events.rows.length).toBeGreaterThan(0);
  });
  it('expires issued links and revokes outstanding links when the API key is revoked',async()=>{
    const p=await approved('EXPIRES');
    const opened=await request(h.app).post(`/v1/claims/proofs/${p.proofId}/open`).set(auth(key)).send(context);
    const token=new URL(opened.body.viewerUrl).pathname.split('/').at(-1);
    now=new Date(now.getTime()+900001);expect((await request(h.app).get(`/public/proofs/${token}`)).status).toBe(404);
    const next=await request(h.app).post(`/v1/claims/proofs/${p.proofId}/open`).set(auth(key)).send(context);
    await revokeApiKey(h.db,clock,owner,tenantId,keyId);
    expect((await request(h.app).get(`/public/proofs/${new URL(next.body.viewerUrl).pathname.split('/').at(-1)}`)).status).toBe(404);
  });
  it('keeps a new staging-style account empty and makes fabricated adapters unavailable',async()=>{
    const app=createServerApp({...h,clock,publicBaseUrl:'http://127.0.0.1',auth:new BearerUserAdapter(h.db),devAuth:true,releaseIdentity:{service:'packproof-api',environment:'staging',commit:null,version:null,image:null}});
    const user=(await request(app).post('/auth/dev/login').send({subject:'clean-account'})).body.userId;
    const before=await request(app).get('/me/proofs').set(auth(user));expect(before.status).toBe(200);
    expect(JSON.stringify(before.body)).not.toContain('proof_');
    const demo=await request(app).post('/integrations/transactions/import').set(auth(user)).send({adapterKey:'demo-marketplace',createProof:true});expect(demo.status).toBeGreaterThanOrEqual(400);
    expect((await request(app).post('/dev/integrations/demo-storefront/connect').set(auth(user)).send({})).status).toBe(404);
    const registry=createDefaultIntegrationRegistry(clock);expect(()=>registry.get('demo-marketplace')).toThrow();expect(()=>registry.getCommerce('demo-storefront')).toThrow();expect(()=>registry.getTrustedShipment('trusted-demo-carrier')).toThrow();
    expect((await request(app).get('/me/proofs').set(auth(user))).body).toEqual(before.body);
  });
  it('reports missing live setup without printing secrets or claiming live validation',()=>{
    const report=integrationReadiness({PACKPROOF_EBAY_ENVIRONMENT:'sandbox',PACKPROOF_EBAY_CLIENT_SECRET:'do-not-print'});
    expect(report.status).toBe('BLOCKED');expect(report.liveValidation).toBe('REQUIRED');expect(report.checks).toHaveLength(6);expect(JSON.stringify(report)).not.toContain('do-not-print');
  });
});
