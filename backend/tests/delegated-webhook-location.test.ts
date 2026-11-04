import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {randomBytes} from 'node:crypto';
import {createPgliteDatabase} from '../src/db/pglite.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {newId} from '../src/ids.js';
import {createTransaction} from '../src/domain/transactions.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
import {createTenant} from '../src/platform/tenants.js';
import {createOrganization,setOrganizationEntitlement,createServicePrincipal,issuePartnerCredential,
 createDelegation,createIntegrationAccount,authenticatePartner,revokeDelegation,type PartnerActor} from '../src/platform/organizations.js';
import {importPartnerOrder} from '../src/platform/partner-proofs.js';
import {createWebhook,dispatchWebhooks,retryWebhookDelivery,verifyWebhook} from '../src/platform/webhooks.js';

describe('delegated webhook current location authorization',()=>{
 let opened:Awaited<ReturnType<typeof createPgliteDatabase>>,admin:string;
 let time=Date.parse('2026-11-04T12:00:00.000Z');const clock={now:()=>new Date(time)};
 const config={encryptionKey:randomBytes(32).toString('base64'),allowedHosts:['example.com']};
 const scopes=['proofs:read','proofs:write','webhooks:manage'];
 beforeAll(async()=>{
  vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED','true');opened=await createPgliteDatabase();await migrate(opened.db);
  admin=await insertUser(opened.db,clock);
  await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
 },60000);
 afterAll(async()=>{await opened?.close();vi.unstubAllEnvs();});

 async function fixture(){
  time+=1000;const owner=await insertUser(opened.db,clock),suffix=newId('fixture');
  const merchant=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:suffix,ownerUserId:owner},'setup')).id;
  const partner=(await createOrganization(opened.db,clock,admin,{kind:'PARTNER',name:`Partner ${suffix}`},'setup')).id;
  for(const id of [merchant,partner])await setOrganizationEntitlement(opened.db,clock,admin,id,{enabled:true},'setup');
  const credential=async(user:string,organization:string)=>{
   const principal=await createServicePrincipal(opened.db,clock,user,organization,{name:'Webhook fixture'},'setup');
   return issuePartnerCredential(opened.db,clock,user,organization,principal.id,{scopes,expiresAt:new Date(time+86400000).toISOString()},'setup');
  };
  const direct=await credential(owner,merchant),delegated=await credential(admin,partner);
  const grant=(await createDelegation(opened.db,clock,owner,merchant,{partnerOrganizationId:partner,scopes,operatorUserIds:[owner],expiresAt:new Date(time+86400000).toISOString()},'setup')).id;
  const a=await authenticatePartner(opened.db,clock,`Bearer ${direct.token}`,merchant,undefined,'fixture');
  const b=await authenticatePartner(opened.db,clock,`Bearer ${delegated.token}`,merchant,grant,'fixture');
  const hook=async(actor:PartnerActor,path:string)=>{
   const value=await createWebhook(opened.db,clock,actor.tenantId,{url:`https://example.com/${suffix}/${path}`,eventTypes:['proof.created']},config);
   await opened.db.query('INSERT INTO platform_webhook_authorizations(webhook_id,merchant_id,credential_id,delegation_id) VALUES($1,$2,$3,$4)',[value.id,merchant,actor.credentialId,actor.delegationGrantId]);return value;
  };
  const directHook=await hook(a,'direct'),delegatedHook=await hook(b,'delegated');
  const account=(await createIntegrationAccount(opened.db,clock,owner,merchant,{provider:'reference',externalAccountId:suffix},'setup')).id;
  const member=(await opened.db.query<{id:string}>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2',[merchant,owner])).rows[0].id;
  const proofId=(await importPartnerOrder(opened.db,clock,a,{integrationAccountId:account,externalId:suffix,operatorMembershipId:member,transaction:{itemTitle:'Synthetic location-controlled shipment'}})).proofId;
  const eventId=(await opened.db.query<{id:string}>("SELECT id FROM proof_outbox WHERE proof_id=$1 AND event_type='proof.created'",[proofId])).rows[0].id;
  const locationId=newId('loc');
  await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,\'Restricted site\',$3)',[locationId,merchant,clock.now().toISOString()]);
  const locate=()=>opened.db.query('INSERT INTO record_state(proof_id,organization_id,environment,location_id,updated_at) VALUES($1,$2,\'sandbox\',$3,$4) ON CONFLICT(proof_id) DO UPDATE SET location_id=EXCLUDED.location_id,revision=record_state.revision+1,updated_at=EXCLUDED.updated_at',[proofId,merchant,locationId,clock.now().toISOString()]);
  return {owner,merchant,grant,a,b,proofId,eventId,directHook,delegatedHook,locate};
 }
 const delivery=async(webhookId:string,eventId:string)=>(await opened.db.query<{id:string;state:string;attempts:number;last_status:number|null;delivered_at:string|Date|null}>('SELECT id,state,attempts,last_status,delivered_at FROM api_webhook_deliveries WHERE webhook_id=$1 AND event_id=$2',[webhookId,eventId])).rows[0];

 it('continues to deliver the same event to direct merchant and delegated hooks for an unlocated record',async()=>{
  const f=await fixture(),sent:Array<{path:string;body:string;headers:Record<string,string>}>=[];
  const result=await dispatchWebhooks(opened.db,clock,config,async(url,body,headers)=>{sent.push({path:url.pathname,body,headers});return 204;},100);
  expect(result).toEqual({delivered:2,failed:0});
  for(const [kind,hook] of [['direct',f.directHook],['delegated',f.delegatedHook]] as const){
   const message=sent.find(item=>item.path.endsWith(`/${kind}`))!;
   expect(JSON.parse(message.body)).toMatchObject({id:f.eventId,data:{proofId:f.proofId}});
   expect(verifyWebhook(hook.secret,message.headers['PackProof-Signature'],message.body,Math.floor(time/1000))).toBe(true);
   expect((await delivery(hook.id,f.eventId)).state).toBe('delivered');
  }
 });

 it('blocks a delivery queued before the record moves into a restricted location and prevents replay bypass',async()=>{
  const f=await fixture();await dispatchWebhooks(opened.db,clock,config,async()=>{throw Error('enqueue only');},0);
  const original=await delivery(f.delegatedHook.id,f.eventId);expect(original.state).toBe('pending');
  await f.locate();const sent:string[]=[];
  expect(await dispatchWebhooks(opened.db,clock,config,async(url)=>{sent.push(url.pathname);return 204;},100)).toEqual({delivered:1,failed:1});
  expect(sent).toHaveLength(1);expect(sent[0]).toMatch(/\/direct$/);
  expect(await delivery(f.delegatedHook.id,f.eventId)).toMatchObject({id:original.id,state:'dead',last_status:null,delivered_at:null});
  const audit=(await opened.db.query<{event_data:Record<string,unknown>}>("SELECT event_data FROM audit_events WHERE proof_id=$1 AND event_type='WEBHOOK_DELIVERY_BLOCKED'",[f.proofId])).rows;
  expect(audit).toHaveLength(1);expect(audit[0].event_data).toMatchObject({deliveryId:original.id,errorCode:'LOCATION_GRANT_REQUIRED',transmitted:false,retryable:false,nextAction:expect.stringContaining('location grant')});
  expect(JSON.stringify(audit)).not.toContain(f.delegatedHook.secret);expect(JSON.stringify(audit)).not.toContain('https://');
  await expect(retryWebhookDelivery(opened.db,clock,f.a.tenantId,original.id)).rejects.toMatchObject({code:'LOCATION_GRANT_REQUIRED'});
  // Even an older/manual replay path that requeues the row cannot bypass dispatch.
  await opened.db.query("UPDATE api_webhook_deliveries SET state='pending',next_attempt_at=$2 WHERE id=$1",[original.id,clock.now().toISOString()]);
  const bypass=vi.fn(async()=>204);expect((await dispatchWebhooks(opened.db,clock,config,bypass,100)).delivered).toBe(0);expect(bypass).not.toHaveBeenCalled();
  expect((await delivery(f.delegatedHook.id,f.eventId)).state).toBe('dead');
 });

 it('records newly enqueued located deliveries as blocked without any send attempt, preserving direct merchant delivery',async()=>{
  const f=await fixture();await f.locate();
  expect(await dispatchWebhooks(opened.db,clock,config,async()=>204,0)).toEqual({delivered:0,failed:1});
  expect(await delivery(f.delegatedHook.id,f.eventId)).toMatchObject({state:'dead',attempts:0,last_status:null,delivered_at:null});
  expect((await delivery(f.directHook.id,f.eventId)).state).toBe('pending');
  const calls:string[]=[];expect((await dispatchWebhooks(opened.db,clock,config,async(url)=>{calls.push(url.pathname);return 204;},100)).delivered).toBe(1);
  expect(calls).toHaveLength(1);expect(calls[0]).toMatch(/\/direct$/);
 });

 it('can explicitly replay the original event only after current scope permits it again',async()=>{
  const f=await fixture();await f.locate();await dispatchWebhooks(opened.db,clock,config,async()=>204,100);
  const blocked=await delivery(f.delegatedHook.id,f.eventId);
  await opened.db.query('UPDATE record_state SET location_id=NULL,revision=revision+1 WHERE proof_id=$1',[f.proofId]);
  expect(await retryWebhookDelivery(opened.db,clock,f.a.tenantId,blocked.id)).toMatchObject({id:blocked.id,state:'pending'});
  time+=1000;const sent:Array<{body:string;signature:string}>=[];
  expect(await dispatchWebhooks(opened.db,clock,config,async(_url,body,headers)=>{sent.push({body,signature:headers['PackProof-Signature']});return 204;},100)).toEqual({delivered:1,failed:0});
  expect(JSON.parse(sent[0].body).id).toBe(f.eventId);expect((await delivery(f.delegatedHook.id,f.eventId)).id).toBe(blocked.id);
  expect(verifyWebhook(f.delegatedHook.secret,sent[0].signature,sent[0].body,Math.floor(time/1000))).toBe(true);
 });

 it('does not let an active unlocated record bypass a revoked partner grant',async()=>{
  const f=await fixture();await dispatchWebhooks(opened.db,clock,config,async()=>204,0);
  await revokeDelegation(opened.db,clock,f.owner,f.merchant,f.grant,'revoke');
  const calls:string[]=[];await dispatchWebhooks(opened.db,clock,config,async(url)=>{calls.push(url.pathname);return 204;},100);
  expect(calls).toHaveLength(1);expect(calls[0]).toMatch(/\/direct$/);
  expect((await delivery(f.delegatedHook.id,f.eventId)).state).not.toBe('delivered');
 });

 it('preserves legacy developer webhook behavior and rechecks current verified ownership',async()=>{
  const owner=await insertUser(opened.db,clock);
  const verified=()=>opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[owner,clock.now().toISOString()]);
  await verified();const tenant=await createTenant(opened.db,clock,owner,{name:'Legacy webhook fixture',environment:'sandbox'});
  const hook=await createWebhook(opened.db,clock,tenant.id,{url:'https://example.com/legacy',eventTypes:['proof.created']},config);
  const transaction=await createTransaction(opened.db,clock,owner,{itemTitle:'Legacy source fixture'}),proof=await createOrGetProof(opened.db,clock,owner,transaction.transactionId);
  await opened.db.query('INSERT INTO api_tenant_proofs(tenant_id,external_id,proof_id,request_hash,created_at) VALUES($1,$2,$3,$4,$5)',[tenant.id,newId('legacy'),proof.proofId,'0'.repeat(64),clock.now().toISOString()]);
  await dispatchWebhooks(opened.db,clock,config,async()=>204,0);
  await opened.db.query('DELETE FROM user_verified_contacts WHERE user_id=$1',[owner]);
  const denied=vi.fn(async()=>204);await dispatchWebhooks(opened.db,clock,config,denied,100);expect(denied).not.toHaveBeenCalled();
  await verified();time+=121000;
  const messages:Array<{body:string;signature:string}>=[];
  expect((await dispatchWebhooks(opened.db,clock,config,async(_url,body,headers)=>{messages.push({body,signature:headers['PackProof-Signature']});return 204;},100)).delivered).toBe(1);
  expect(messages).toHaveLength(1);expect(JSON.parse(messages[0].body).data.proofId).toBe(proof.proofId);
  expect(verifyWebhook(hook.secret,messages[0].signature,messages[0].body,Math.floor(time/1000))).toBe(true);
 });
});
