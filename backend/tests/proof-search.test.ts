import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, createUser, commitFulfillmentAndAttest, commitProofEvidence, type TestHarness } from './helpers.js';
import { createTransaction } from '../src/domain/transactions.js';
import { createOrGetProof } from '../src/domain/create-proof.js';
import { commitAttestation } from '../src/domain/attestations.js';
import { finalizeProof } from '../src/domain/finalize.js';
import { processRecoveryOutbox, type RecoveryPublisher } from '../src/domain/recovery-journal.js';
import { processPolicyRecoveryOutbox } from '../src/domain/policy-recovery.js';
import { createTenant, issueApiKey, authenticateApiKey } from '../src/platform/tenants.js';
import { parseProofSearchQuery, proofSearchReadiness, searchUserProofs, searchTenantProofs, searchPartnerProofs } from '../src/platform/proof-search.js';
import { createOrganization,setOrganizationEntitlement,createServicePrincipal,issuePartnerCredential,createIntegrationAccount,authenticatePartner,revokePartnerCredential } from '../src/platform/organizations.js';
import { importPartnerOrder } from '../src/platform/partner-proofs.js';
import type { ManifestSigner } from '../src/domain/manifest-signing.js';

const key=randomBytes(32).toString('base64');
let now=new Date('2026-10-28T12:00:00.000Z');
const clock={now:()=>new Date(now)};
const facts={status:'FINALIZED',workflow_type:'COMMERCE_SALE',finalized_at:now.toISOString(),committed_count:1,fulfillment_count:1,
  packing_attested:true,pending_count:0,required_count:3,preserved_count:3,failed_count:0,missing_count:0,has_manifest:true,active_capture:false};

describe('bounded proof search and authoritative readiness',()=>{
 let h:TestHarness;
 beforeAll(async()=>{h=await createHarness(clock);},60000);
 afterAll(async()=>{await h?.close();});
 async function proof(user:string,title:string,tracking='TRACK-1001'){
  const transaction=await createTransaction(h.db,clock,user,{itemTitle:title,shipping:{carrier:'UPS',trackingNumber:tracking}});
  return createOrGetProof(h.db,clock,user,transaction.transactionId);
 }
 it('validates real UTC calendar dates, text, states and page bounds before querying',()=>{
  expect(parseProofSearchQuery({from:'2024-02-29',through:'2024-02-29',limit:'2'})).toMatchObject({from:'2024-02-29',limit:2});
  for(const input of [{from:'2026-02-29'},{through:'2026-01-01',from:'2026-01-02'},{from:'0000-01-01'},{q:['bad']},{state:'FINALIZED'},{limit:'51'},{unexpected:'merchant-b'}])
    expect(()=>parseProofSearchQuery(input)).toThrow();
 });
 it('does not equate canonical finalization, missing receipts or pending uploads with Ready',()=>{
  expect(proofSearchReadiness(facts)).toEqual({state:'READY',reason:null,preserved:true});
  expect(proofSearchReadiness({...facts,preserved_count:2})).toMatchObject({state:'IN_PROGRESS',reason:'PRESERVATION_PENDING',preserved:false});
  expect(proofSearchReadiness({...facts,missing_count:1,preserved_count:2})).toMatchObject({state:'NEEDS_ATTENTION',reason:'LEGACY_UNCONFIRMED',preserved:false});
  expect(proofSearchReadiness({...facts,packing_attested:false})).toMatchObject({state:'NEEDS_ATTENTION',preserved:false});
  expect(proofSearchReadiness({...facts,pending_count:1})).toMatchObject({state:'IN_PROGRESS',preserved:false});
  expect(proofSearchReadiness({...facts,failed_count:1})).toMatchObject({state:'NEEDS_ATTENTION',reason:'PRESERVATION_FAILED'});
  expect(proofSearchReadiness({...facts,status:'READY_FOR_EVIDENCE',finalized_at:null,committed_count:0,fulfillment_count:0,packing_attested:false,preserved_count:0})).toMatchObject({state:'AWAITING_CAPTURE',preserved:false});
 });
 it('searches authorized order/tracking references, literal wildcards and inclusive UTC dates with stable cursor pages',async()=>{
  const seller=await createUser(h),other=await createUser(h);
  const a=await proof(seller,'Needle 100% item'),b=await proof(seller,'Needle second item','TRACK-1002');
  const hidden=await proof(other,'Needle private item','PRIVATE-TRACK');
  now=new Date('2026-10-29T03:00:00.000Z');
  await proof(seller,'Needle next UTC day','NEXT-DAY-TRACK');
  now=new Date('2026-10-28T12:00:00.000Z');
  await h.db.query("SET TIME ZONE 'Pacific/Honolulu'");
  const first=await searchUserProofs(h.db,clock,seller,{q:'Needle',limit:'1',from:'2026-10-28',through:'2026-10-28'},key);
  expect(first.proofs).toHaveLength(1);expect(first.hasMore).toBe(true);
  const second=await searchUserProofs(h.db,clock,seller,{q:'Needle',limit:'1',from:'2026-10-28',through:'2026-10-28',after:first.nextCursor!},key);
  expect(new Set([...first.proofs,...second.proofs].map(r=>r.proofId))).toEqual(new Set([a.proofId,b.proofId]));
  expect(second.nextCursor).toBeNull();
  expect(first.proofs.some(r=>r.proofId===hidden.proofId)).toBe(false);
  expect((await searchUserProofs(h.db,clock,seller,{q:'100%'},key)).proofs.map(r=>r.proofId)).toEqual([a.proofId]);
  expect((await searchUserProofs(h.db,clock,seller,{q:'TRACK-1002'},key)).proofs.map(r=>r.proofId)).toEqual([b.proofId]);
  expect((await searchUserProofs(h.db,clock,seller,{from:'2026-10-29',through:'2026-10-29'},key)).proofs).toHaveLength(1);
  await expect(searchUserProofs(h.db,clock,other,{q:'Needle',limit:'1',from:'2026-10-28',through:'2026-10-28',after:first.nextCursor!},key)).rejects.toMatchObject({code:'INVALID_PROOF_SEARCH'});
  await expect(searchUserProofs(h.db,clock,seller,{q:'changed',limit:'1',after:first.nextCursor!},key)).rejects.toMatchObject({code:'INVALID_PROOF_SEARCH'});
  const tampered=first.nextCursor!.slice(0,-4)+'xxxx';
  await expect(searchUserProofs(h.db,clock,seller,{q:'Needle',limit:'1',from:'2026-10-28',through:'2026-10-28',after:tampered},key)).rejects.toMatchObject({code:'INVALID_PROOF_SEARCH'});
  now=new Date(now.getTime()+3600001);
  await expect(searchUserProofs(h.db,clock,seller,{q:'Needle',limit:'1',from:'2026-10-28',through:'2026-10-28',after:first.nextCursor!},key)).rejects.toMatchObject({code:'CURSOR_EXPIRED'});
  now=new Date('2026-10-28T12:00:00.000Z');
  await h.db.query("SET TIME ZONE 'UTC'");
 });
 it('keeps tenant-scoped same-owner searches separate and rejects revoked credentials',async()=>{
  const admin=await createUser(h);
  await h.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
  const tenantA=await createTenant(h.db,clock,admin,{name:'Search A'}),tenantB=await createTenant(h.db,clock,admin,{name:'Search B'});
  const credential=await issueApiKey(h.db,clock,admin,String(tenantA.id),{name:'Search key',scopes:['proofs:read']});
  const principal=await authenticateApiKey(h.db,'Bearer '+credential.token);
  const a=await proof(admin,'Identical order'),b=await proof(admin,'Identical order');
  for(const [tenant,id] of [[tenantA.id,a.proofId],[tenantB.id,b.proofId]])await h.db.query('INSERT INTO api_tenant_proofs(tenant_id,external_id,proof_id,request_hash,created_at) VALUES($1,$2,$3,$4,$5)',[tenant,'ORDER-1001',id,'synthetic-search-fixture',clock.now().toISOString()]);
  const page=await searchTenantProofs(h.db,clock,principal,{q:'ORDER-1001'},key);
  expect(page.proofs.map(r=>r.proofId)).toEqual([a.proofId]);expect(page.proofs[0].externalId).toBe('ORDER-1001');
  await h.db.query('UPDATE api_keys SET revoked_at=$2 WHERE id=$1',[credential.id,clock.now().toISOString()]);
  await expect(searchTenantProofs(h.db,clock,principal,{},key)).rejects.toMatchObject({code:'UNAUTHENTICATED'});
 });
 it('checks partner credentials and current merchant ownership on every search',async()=>{
  const admin=await createUser(h);
  // Exact pilot allowlist entitlement is verified, not inferred from an owner name.
  await h.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'admin@thepackproof.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
  const org=await createOrganization(h.db,clock,admin,{name:'Search merchant',kind:'MERCHANT'},'search-setup');
  await setOrganizationEntitlement(h.db,clock,admin,org.id,{enabled:true},'search-setup');
  const member=(await h.db.query<{id:string}>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2',[org.id,admin])).rows[0].id;
  const principal=await createServicePrincipal(h.db,clock,admin,org.id,{name:'Search service'},'search-setup');
  const credential=await issuePartnerCredential(h.db,clock,admin,org.id,principal.id,{scopes:['proofs:read','proofs:write'],expiresAt:new Date(now.getTime()+86400000).toISOString()},'search-setup');
  const account=await createIntegrationAccount(h.db,clock,admin,org.id,{provider:'reference',externalAccountId:'search-merchant'},'search-setup');
  const actor=await authenticatePartner(h.db,clock,'Bearer '+credential.token,org.id,undefined,'search-test');
  const imported=await importPartnerOrder(h.db,clock,actor,{integrationAccountId:account.id,externalId:'PARTNER-1001',operatorMembershipId:member,transaction:{itemTitle:'Partner search item'}});
  expect((await searchPartnerProofs(h.db,clock,actor,{q:'PARTNER-1001',integrationAccountId:account.id},key)).proofs.map(r=>r.proofId)).toEqual([imported.proofId]);
  expect((await searchPartnerProofs(h.db,clock,actor,{integrationAccountId:'another-merchants-account'},key)).proofs).toEqual([]);
  await revokePartnerCredential(h.db,clock,admin,org.id,credential.id,'search-revoke');
  await expect(searchPartnerProofs(h.db,clock,actor,{},key)).rejects.toMatchObject({code:'INSUFFICIENT_SCOPE'});
 });
 it('shows Ready only after the actual recovery publisher verifies every required root receipt',async()=>{
  const seller=await createUser(h),created=await proof(seller,'Durable search item');
  const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicPem=pair.publicKey.export({format:'pem',type:'spki'}).toString();
  const signer:ManifestSigner={signManifest:async input=>({algorithm:'ECDSA_SHA_256',keyId:'search-test-key',signedAt:clock.now().toISOString(),signatureBase64:sign('sha256',Buffer.from(input.canonicalJson),pair.privateKey).toString('base64')})};
  const objects=new Map<string,Buffer>();
  const publisher:RecoveryPublisher={writerGeneration:'initial',protectedStoreVerified:true,signer,trustedPublicKey:async id=>id==='search-test-key'?publicPem:null,store:{
    async putIfAbsent(k,body){if(objects.has(k))return {created:false};objects.set(k,body);return {created:true};},
    async get(k){const body=objects.get(k);return body?{body,contentType:'application/json'}:null;},
    async head(k){return objects.has(k)?{versionId:'search-test-immutable-version'}:null;},
  }};
  while((await processPolicyRecoveryOutbox(h.db,clock,publisher)).processed){/* Existing protected policy contract. */}
  await commitFulfillmentAndAttest(h,seller,created.proofId);
  await finalizeProof(h.db,clock,seller,created.proofId,signer);
  expect((await searchUserProofs(h.db,clock,seller,{state:'READY'},key)).proofs).toEqual([]);
  while((await processRecoveryOutbox(h.db,clock,publisher)).processed){/* Actual signature and exact-version verification. */}
  const legacy=await proof(seller,'Legacy unlinked confirmation');
  await commitProofEvidence(h,seller,legacy.proofId,{evidenceType:'FULFILLMENT_CAPTURE'});
  await commitAttestation(h.db,clock,seller,legacy.proofId,{statement:'PACKED_DESCRIBED_ITEM'});
  await finalizeProof(h.db,clock,seller,legacy.proofId,signer);
  while((await processRecoveryOutbox(h.db,clock,publisher)).processed){/* Durability must not upgrade an unlinked declaration. */}
  const legacySearch=await searchUserProofs(h.db,clock,seller,{q:'Legacy unlinked confirmation'},key);
  expect(legacySearch.proofs[0].readiness).toMatchObject({state:'NEEDS_ATTENTION',preserved:false,reason:'FINALIZATION_INCOMPLETE'});
  const ready=(await searchUserProofs(h.db,clock,seller,{state:'READY'},key)).proofs;
  expect(ready).toHaveLength(1);expect(ready[0]).toMatchObject({proofId:created.proofId,readiness:{state:'READY',preserved:true}});
  // A stale/mismatched delivery projection is not enough to advertise durable readiness.
  await h.db.query("UPDATE recovery_delivery SET receipt_json=jsonb_set(receipt_json,'{eventSha256}',to_jsonb('wrong-event'::text)) WHERE operation_id=$1",['finalize:'+created.proofId]);
  expect((await searchUserProofs(h.db,clock,seller,{state:'READY'},key)).proofs).toEqual([]);
 },60000);
});
