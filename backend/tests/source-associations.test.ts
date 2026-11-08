import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {randomBytes} from 'node:crypto';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {createOrganization,setOrganizationEntitlement,createServicePrincipal,issuePartnerCredential,createIntegrationAccount,authenticatePartner,PARTNER_SCOPES,addOrganizationMember,type PartnerActor} from '../src/platform/organizations.js';
import {importPartnerOrder} from '../src/platform/partner-proofs.js';
import {acceptReferenceObservation,readReferenceObservation,resolveSourceReference,processSourceAssociations,approveSourceCrosswalk,listSourceAssociations,replaySourceAssociation,parseReferenceObservation} from '../src/records/source-associations.js';
import {decideSourceReference,shipmentBindingKey} from '../src/records/source-reference.js';
import {processSourceIngestions,readSourceOperation,acceptSourceIngestion} from '../src/records/ingestions.js';
import {requireRecordWorkspace} from '../src/records/access.js';
import {actOnRecordConnection} from '../src/records/connections.js';
import {getRecord,changeRecordLifecycle,readRecordIssues} from '../src/records/service.js';
import {sha256Hex} from '../src/hash.js';
import {canonicalize} from '../src/canonical.js';
import type {Database} from '../src/db/database.js';

describe('source reference resolution and durable unattended assembly',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,admin:string,owner:string,org:string,member:string,account:string,secondAccount:string,proof:string,actor:PartnerActor,otherActor:PartnerActor;
 let time=Date.now();const clock={now:()=>new Date(time)};
 const envelope=(id:string,externalId='000045',extra:Record<string,unknown>={})=>({connectionId:account,locationId:null,reference:{type:'ORDER',externalId},sourceKind:'Synthetic scheduled exporter',sourceSchemaVersion:'1.0',mappingVersion:'fixture/v1',event:{sourceEventId:id,eventType:'DELIVERED',reportedAt:'2026-11-03T12:00:00-05:00',data:{note:'Fixture assertion'}},...extra});
 const workspace=()=>requireRecordWorkspace(opened.db,owner,org,'sandbox',true);
 beforeAll(async()=>{
  vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED','true');vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY',randomBytes(32).toString('base64'));
  opened=await openIsolatedTestDatabase();await migrate(opened.db);
  [admin,owner]=await Promise.all([insertUser(opened.db,clock),insertUser(opened.db,clock)]);
  await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
  org=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Association warehouse',ownerUserId:owner},'setup')).id;
  await setOrganizationEntitlement(opened.db,clock,admin,org,{enabled:true},'setup');
  member=(await opened.db.query<{id:string}>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2',[org,owner])).rows[0].id;
  const principal=await createServicePrincipal(opened.db,clock,owner,org,{name:'Source observer'},'setup');
  const token=await issuePartnerCredential(opened.db,clock,owner,org,principal.id,{scopes:[...PARTNER_SCOPES],expiresAt:new Date(time+86400000).toISOString()},'setup');
  actor=await authenticatePartner(opened.db,clock,`Bearer ${token.token}`,org,undefined,'source-test');
  account=(await createIntegrationAccount(opened.db,clock,owner,org,{provider:'source-fixture',externalAccountId:'primary'},'setup')).id;
  secondAccount=(await createIntegrationAccount(opened.db,clock,owner,org,{provider:'source-fixture',externalAccountId:'second'},'setup')).id;
  proof=(await importPartnerOrder(opened.db,clock,actor,{integrationAccountId:account,externalId:'000045',operatorMembershipId:member,transaction:{itemTitle:'Source proof'}})).proofId;
  const otherOwner=await insertUser(opened.db,clock),otherOrg=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Other warehouse',ownerUserId:otherOwner},'other')).id;
  await setOrganizationEntitlement(opened.db,clock,admin,otherOrg,{enabled:true},'other');
  const p=await createServicePrincipal(opened.db,clock,otherOwner,otherOrg,{name:'Other observer'},'other'),t=await issuePartnerCredential(opened.db,clock,otherOwner,otherOrg,p.id,{scopes:[...PARTNER_SCOPES],expiresAt:new Date(time+86400000).toISOString()},'other');
  otherActor=await authenticatePartner(opened.db,clock,`Bearer ${t.token}`,otherOrg,undefined,'other');
 },60000);
 afterAll(async()=>{await opened?.close();vi.unstubAllEnvs();});
 it('uses explicit precedence, unique children, and preserves padded/Unicode/location identities',()=>{
  expect(decideSourceReference(['p1'],['p2'],['p3'])).toMatchObject({outcome:'linked',proofId:'p1',basis:'immutable_binding'});
  expect(decideSourceReference([],[],['p2','p1','p2'])).toMatchObject({outcome:'unresolved_ambiguous',proofId:null,candidates:['p1','p2']});
  expect(shipmentBindingKey('00001','north')).not.toBe(shipmentBindingKey('00001','south'));
  expect(shipmentBindingKey('É-00001',null)).toBe('É-00001');
 });
 it('resolves exact current bindings and never uses an approximate tracking reference',async()=>{
  expect(await resolveSourceReference(opened.db,clock,actor,{connectionId:account,locationId:null,reference:{type:'ORDER',externalId:'000045'}})).toMatchObject({outcome:'linked',proofId:proof});
  expect(await resolveSourceReference(opened.db,clock,actor,{connectionId:account,locationId:null,reference:{type:'ORDER',externalId:'45'}})).toMatchObject({outcome:'unresolved_no_match'});
 });
 it('durably preserves complete originals, deduplicates lost acknowledgments and appends through the bound event service',async()=>{
  const input=envelope('event-001'),accepted=await acceptReferenceObservation(opened.db,clock,actor,input,'event-001');
  expect(accepted.state).toBe('pending');
  const replay=await acceptReferenceObservation(opened.db,clock,actor,input,'event-001');expect(replay.replayed).toBe(true);expect(replay.id).toBe(accepted.id);
  const duplicate=await acceptReferenceObservation(opened.db,clock,actor,input,'event-001-new-command');expect(duplicate.duplicate).toBe(true);expect(duplicate.id).toBe(accepted.id);
  await processSourceAssociations(opened.db,clock);const submitted=await readReferenceObservation(opened.db,clock,actor,accepted.id);expect(submitted).toMatchObject({state:'submitted',proofId:proof});
  await processSourceIngestions(opened.db,clock);
  const done=await readSourceOperation(opened.db,clock,actor,submitted.operationId!);expect(done.items[0].status).toBe('imported');
  const original=(await opened.db.query<{payload_canonical:string;payload_sha256:string}>('SELECT payload_canonical,payload_sha256 FROM record_source_pending WHERE id=$1',[accepted.id])).rows[0];expect(JSON.parse(original.payload_canonical)).toEqual(input);expect(sha256Hex(original.payload_canonical)).toBe(original.payload_sha256);
  await expect(opened.db.query("UPDATE record_source_pending SET payload_canonical='changed' WHERE id=$1",[accepted.id])).rejects.toThrow(/immutable/);
  expect((await opened.db.query('SELECT 1 FROM attestations WHERE proof_id=$1',[proof])).rows).toHaveLength(0);
  const detail=await getRecord(opened.db,clock,await workspace(),proof);expect(detail.record.id).toBe(proof);
 });
 it('retains changed source identities as conflicts without reassigning the accepted observation',async()=>{
  const changed=await acceptReferenceObservation(opened.db,clock,actor,envelope('event-001','unknown-order'),'changed-event');expect(changed.state).toBe('conflict');
  await expect(replaySourceAssociation(opened.db,clock,await workspace(),changed.id,{reason:'Cannot move a conflicting event'},'bad-replay')).rejects.toMatchObject({code:'SOURCE_REPLAY_UNAVAILABLE'});
 });
 it('automatically resolves an event arriving before its shipment and retries without a second canonical record',async()=>{
  const early=await acceptReferenceObservation(opened.db,clock,actor,envelope('early-001','LATE-0001'),'early-001');
  await processSourceAssociations(opened.db,clock);expect((await readReferenceObservation(opened.db,clock,actor,early.id)).resolution.outcome).toBe('unresolved_no_match');
  const late=(await importPartnerOrder(opened.db,clock,actor,{integrationAccountId:account,externalId:'LATE-0001',operatorMembershipId:member,transaction:{itemTitle:'Late shipment'}})).proofId;
  time+=300001;await processSourceAssociations(opened.db,clock);await processSourceIngestions(opened.db,clock);
  expect(await readReferenceObservation(opened.db,clock,actor,early.id)).toMatchObject({state:'submitted',proofId:late});
  expect((await opened.db.query('SELECT 1 FROM platform_external_bindings WHERE proof_id=$1 AND resource_type=\'ORDER\'',[late])).rows).toHaveLength(1);
 });
 it('requires an explicit human crosswalk before another source can attach events or originals',async()=>{
  const input=envelope('second-001','ERP-0003',{connectionId:secondAccount}),pending=await acceptReferenceObservation(opened.db,clock,actor,input,'second-001');
  const body={connectionId:secondAccount,locationId:null,reference:{type:'ORDER',externalId:'ERP-0003'},proofId:proof,ruleVersion:'approved-fixture/v1',reason:'Owner checked the exact warehouse shipment identity'};
  await approveSourceCrosswalk(opened.db,clock,await workspace(),body,'approve-second');await processSourceAssociations(opened.db,clock);await processSourceIngestions(opened.db,clock);
  expect(await readReferenceObservation(opened.db,clock,actor,pending.id)).toMatchObject({state:'submitted',proofId:proof});
  expect((await opened.db.query('SELECT 1 FROM platform_external_bindings WHERE proof_id=$1 AND integration_account_id=$2',[proof,secondAccount])).rows).toHaveLength(1);
  const other=(await importPartnerOrder(opened.db,clock,actor,{integrationAccountId:account,externalId:'OTHER-CROSSWALK',operatorMembershipId:member,transaction:{itemTitle:'Other target'}})).proofId;
  await expect(approveSourceCrosswalk(opened.db,clock,await workspace(),{...body,proofId:other},'cannot-reassign')).rejects.toMatchObject({code:'SOURCE_CROSSWALK_CONFLICT'});
  await expect(approveSourceCrosswalk(opened.db,clock,{...await workspace(),partner:actor},body,'service-forged-human')).rejects.toBeDefined();
 });
 it('assembles source-attributed children and quantity corrections append-only, leaving ambiguous children unlinked',async()=>{
  const first=await acceptReferenceObservation(opened.db,clock,actor,envelope('package-1','000045',{facts:[{kind:'package',externalReference:'PKG-0001',attributes:{expectedQuantity:2,observedQuantity:1,units:'each'}}]}),'package-1');await processSourceAssociations(opened.db,clock);await processSourceIngestions(opened.db,clock);
  expect(await readReferenceObservation(opened.db,clock,actor,first.id)).toMatchObject({state:'submitted'});
  const corrected=await acceptReferenceObservation(opened.db,clock,actor,envelope('package-2','000045',{facts:[{kind:'package',externalReference:'PKG-0001',attributes:{expectedQuantity:2,observedQuantity:2,units:'each'}}]}),'package-2');await processSourceAssociations(opened.db,clock);
  expect(await readReferenceObservation(opened.db,clock,actor,corrected.id)).toMatchObject({state:'submitted'});
  const history=(await opened.db.query<{supersedes_id:string|null}>("SELECT supersedes_id FROM record_entities WHERE proof_id=$1 AND external_reference='PKG-0001' ORDER BY created_at,id",[proof])).rows;expect(history).toHaveLength(2);expect(history.filter(r=>r.supersedes_id)).toHaveLength(1);
  expect((await readRecordIssues(opened.db,proof)).some(i=>i.category==='quantity_mismatch'&&i.status==='open')).toBe(true);
  const linked=await resolveSourceReference(opened.db,clock,actor,{connectionId:account,locationId:null,reference:{type:'package',externalId:'PKG-0001'}});expect(linked.proofId).toBe(proof);
  const another=(await importPartnerOrder(opened.db,clock,actor,{integrationAccountId:account,externalId:'ANOTHER-PACKAGE',operatorMembershipId:member,transaction:{itemTitle:'Other package shipment'}})).proofId;
  await acceptReferenceObservation(opened.db,clock,actor,envelope('package-ambiguous','ANOTHER-PACKAGE',{facts:[{kind:'package',externalReference:'PKG-0001',attributes:{}}]}),'package-ambiguous');await processSourceAssociations(opened.db,clock);
  expect(await resolveSourceReference(opened.db,clock,actor,{connectionId:account,locationId:null,reference:{type:'package',externalId:'PKG-0001'}})).toMatchObject({outcome:'unresolved_ambiguous',proofId:null});
 });
 it('uses exact decimal quantity comparisons and flags unknown pack units without guessing conversions',async()=>{
  const assertion=(amount:string,unit:string)=>({quantity:{amount,unit},source:{system:'fixture',reference:'quantity-source',reportedAt:'2026-11-07T00:00:00Z'}});
  const comparison={schema:'packproof.quantity-comparison/v1',expected:assertion('1.000','kg'),observed:assertion('1000','g')};
  const first=await acceptReferenceObservation(opened.db,clock,actor,envelope('decimal-quantity','000045',{facts:[{kind:'item',externalReference:'DECIMAL-ITEM',attributes:{quantityComparison:comparison}}]}),'decimal-quantity');await processSourceAssociations(opened.db,clock,50);
  expect(await readReferenceObservation(opened.db,clock,actor,first.id)).toMatchObject({state:'submitted'});
  const attributes=(await opened.db.query<{attributes:{quantityComparison:{evaluation:{outcome:string}}}}>("SELECT attributes FROM record_entities WHERE external_reference='DECIMAL-ITEM'")).rows[0].attributes;expect(attributes.quantityComparison.evaluation.outcome).toBe('within_tolerance');
  const unknown=await acceptReferenceObservation(opened.db,clock,actor,envelope('unknown-pack','000045',{facts:[{kind:'item',externalReference:'UNKNOWN-PACK',attributes:{quantityComparison:{...comparison,observed:assertion('1','case')}}}]}),'unknown-pack');await processSourceAssociations(opened.db,clock,50);
  expect(await readReferenceObservation(opened.db,clock,actor,unknown.id)).toMatchObject({state:'submitted'});
  expect((await readRecordIssues(opened.db,proof)).some(i=>i.category==='quantity_not_comparable')).toBe(true);
 });
 it('does not confuse literal exporter IDs with generated location binding keys',async()=>{
  await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',['binding-north',org,'Binding north',clock.now().toISOString()]);
  await opened.db.query('UPDATE record_state SET location_id=$2 WHERE proof_id=$1',[proof,'binding-north']);
  const encoded=shipmentBindingKey('000001','binding-north');
  await opened.db.query("INSERT INTO platform_external_bindings(merchant_id,environment,integration_account_id,resource_type,external_id,proof_id,snapshot_sha256,created_at) VALUES($1,'sandbox',$2,'SHIPMENT',$3,$4,$5,$6)",[org,account,encoded,proof,'a'.repeat(64),clock.now().toISOString()]);
  expect(await resolveSourceReference(opened.db,clock,actor,{connectionId:account,locationId:'binding-north',reference:{type:'SHIPMENT',externalId:'000001'}})).toMatchObject({proofId:proof});
  expect(await resolveSourceReference(opened.db,clock,actor,{connectionId:account,locationId:'binding-north',reference:{type:'SHIPMENT',externalId:encoded}})).toMatchObject({outcome:'unresolved_no_match',proofId:null});
  await opened.db.query('UPDATE record_state SET location_id=NULL WHERE proof_id=$1',[proof]);
  expect(await resolveSourceReference(opened.db,clock,actor,{connectionId:account,locationId:null,reference:{type:'SHIPMENT',externalId:encoded}})).toMatchObject({outcome:'unresolved_no_match',proofId:null});
 });
 it('does not let manually copied source attributes invent a new child identity',async()=>{
  const receipt=(await opened.db.query<{id:string}>("SELECT id FROM record_source_pending WHERE source_event_id='event-001' AND state='submitted'")).rows[0].id;
  await opened.db.query("INSERT INTO record_entities(id,proof_id,kind,external_reference,attributes,actor_user_id,created_at) VALUES('forged-child',$1,'package','FORGED-PKG',$2::jsonb,$3,$4)",[proof,JSON.stringify({sourceReceiptId:receipt,sourceConnectionId:account}),owner,clock.now().toISOString()]);
  expect(await resolveSourceReference(opened.db,clock,actor,{connectionId:account,locationId:null,reference:{type:'package',externalId:'FORGED-PKG'}})).toMatchObject({outcome:'unresolved_no_match'});
  const pending=await acceptReferenceObservation(opened.db,clock,actor,envelope('forged-correction','000045',{facts:[{kind:'package',externalReference:'FORGED-PKG',attributes:{}}]}),'forged-correction');await processSourceAssociations(opened.db,clock,50);
  expect(await readReferenceObservation(opened.db,clock,actor,pending.id)).toMatchObject({state:'blocked_policy',errorCode:'SOURCE_ENTITY_CONFLICT'});
 });
 it('does not apply entity facts when canonical event admission reports a source identity conflict',async()=>{
  const sourceEventId='downstream-conflict',canonicalId='reference:v1:'+sha256Hex(canonicalize({connection:account,location:null,id:sourceEventId}));
  await acceptSourceIngestion(opened.db,clock,actor,{connectionId:account,events:[{sourceEventId:canonicalId,proofId:proof,eventType:'IN_TRANSIT',reportedAt:'2026-11-03T12:00:00-05:00'}]},'canonical-preexisting');
  await processSourceIngestions(opened.db,clock,50);
  const pending=await acceptReferenceObservation(opened.db,clock,actor,envelope(sourceEventId,'000045',{facts:[{kind:'package',externalReference:'MUST-NOT-APPLY',attributes:{}}]}),'downstream-conflict');await processSourceAssociations(opened.db,clock,50);
  expect(await readReferenceObservation(opened.db,clock,actor,pending.id)).toMatchObject({state:'conflict',errorCode:'SOURCE_EVENT_CONFLICT',operationId:null});
  expect((await opened.db.query("SELECT 1 FROM record_entities WHERE external_reference='MUST-NOT-APPLY'")).rows).toHaveLength(0);
 });
 it('rolls back admission when a record location changes before its canonical state lock',async()=>{
  const pending=await acceptReferenceObservation(opened.db,clock,actor,envelope('location-race'),'location-race');let changed=false;
  const wrap=(base:Database):Database=>({query:async<T=Record<string,unknown>>(sql:string,params?:unknown[])=>{const result=await base.query<T>(sql,params);if(!changed&&sql.startsWith('SELECT DISTINCT b.proof_id')){changed=true;await base.query('UPDATE record_state SET location_id=$2 WHERE proof_id=$1',[proof,'binding-north']);}return result;},transaction:fn=>base.transaction(tx=>fn(wrap(tx)))});
  await processSourceAssociations(wrap(opened.db),clock,50);
  expect(await readReferenceObservation(opened.db,clock,actor,pending.id)).toMatchObject({state:'blocked_policy',errorCode:'SOURCE_LOCATION_CHANGED',operationId:null});
  expect((await opened.db.query<{location_id:string|null}>('SELECT location_id FROM record_state WHERE proof_id=$1',[proof])).rows[0].location_id).toBeNull();
 });
 it('keeps tenant, location, role and credential authority ahead of receipt and mapping lookups',async()=>{
  await expect(acceptReferenceObservation(opened.db,clock,otherActor,envelope('cross-tenant'),'cross-tenant')).rejects.toMatchObject({code:'CONNECTION_NOT_FOUND'});
  await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',['assoc-north',org,'North',clock.now().toISOString()]);
  await expect(approveSourceCrosswalk(opened.db,clock,await workspace(),{connectionId:account,locationId:'assoc-north',reference:{type:'ORDER',externalId:'wrong-location'},proofId:proof,ruleVersion:'test/v1',reason:'Must not move location'},'wrong-location')).rejects.toMatchObject({code:'SOURCE_LOCATION_MISMATCH'});
  const unknown=await acceptReferenceObservation(opened.db,clock,actor,envelope('hidden-001','NO-MATCH'),'hidden-001');
  await expect(readReferenceObservation(opened.db,clock,otherActor,unknown.id)).rejects.toMatchObject({code:'OPERATION_NOT_FOUND'});
  const w=await workspace(),reviewer=await insertUser(opened.db,clock);await addOrganizationMember(opened.db,clock,owner,org,{userId:reviewer,role:'REVIEWER'},'reviewer');const reviewerWorkspace=await requireRecordWorkspace(opened.db,reviewer,org,'sandbox');
  await expect(approveSourceCrosswalk(opened.db,clock,reviewerWorkspace,{connectionId:account,locationId:null,reference:{type:'ORDER',externalId:'NO-MATCH'},proofId:proof,ruleVersion:'test/v1',reason:'No reviewer write'},'reviewer-denied')).rejects.toMatchObject({code:'RECORD_PERMISSION_DENIED'});
  expect((await listSourceAssociations(opened.db,w,{limit:1})).items).toHaveLength(1);
 });
 it('rechecks pause before publishing queued work and records administrator replay without changing originals',async()=>{
  const pending=await acceptReferenceObservation(opened.db,clock,actor,envelope('paused-001'),'paused-001'),w=await workspace();
  await actOnRecordConnection(opened.db,clock,w,account,{action:'pause'},'pause-queue');await processSourceAssociations(opened.db,clock,50);
  expect(await readReferenceObservation(opened.db,clock,actor,pending.id)).toMatchObject({state:'blocked_policy',errorCode:'CONNECTION_PAUSED'});
  await actOnRecordConnection(opened.db,clock,w,account,{action:'resume'},'resume-queue');
  await replaySourceAssociation(opened.db,clock,w,pending.id,{reason:'Source access repaired'},'replay-repaired');await processSourceAssociations(opened.db,clock,50);
  expect(await readReferenceObservation(opened.db,clock,actor,pending.id)).toMatchObject({state:'submitted'});
 });
 it('rolls back event admission and entity writes together on interruption, then safely retries',async()=>{
  const pending=await acceptReferenceObservation(opened.db,clock,actor,envelope('crash-001','000045',{facts:[{kind:'package',externalReference:'CRASH-PKG',attributes:{}}]}),'crash-001');let crash=true;
  const wrap=(base:Database):Database=>({query:async<T=Record<string,unknown>>(sql:string,params?:unknown[])=>{const result=await base.query<T>(sql,params);if(crash&&sql.startsWith('INSERT INTO record_entities')){crash=false;throw Error('synthetic worker crash');}return result;},transaction:fn=>base.transaction(tx=>fn(wrap(tx)))});
  await processSourceAssociations(wrap(opened.db),clock,50);expect(await readReferenceObservation(opened.db,clock,actor,pending.id)).toMatchObject({state:'retryable_error',operationId:null});
  expect((await opened.db.query("SELECT 1 FROM record_entities WHERE external_reference='CRASH-PKG'")).rows).toHaveLength(0);
  time+=300001;await processSourceAssociations(opened.db,clock,50);expect(await readReferenceObservation(opened.db,clock,actor,pending.id)).toMatchObject({state:'submitted'});
  expect((await opened.db.query("SELECT 1 FROM record_entities WHERE external_reference='CRASH-PKG'")).rows).toHaveLength(1);
 });
 it('rejects source secrets, ambiguous timestamps, forged authority and extra commands before acceptance',()=>{
  for(const extra of [{event:{sourceEventId:'secret',eventType:'DELIVERED',reportedAt:'2026-11-03T17:00:00Z',data:{apiKey:'secret'}}},{facts:[{kind:'package',externalReference:'private',attributes:{objectKey:'private/key'}}]},{facts:[{kind:'package',externalReference:'private-url',attributes:{note:'https://private.example/file'}}]},{attest:true},{event:{sourceEventId:'clock',eventType:'DELIVERED',reportedAt:'2026-11-03T01:30:00'}},{facts:[{kind:'human-review',externalReference:'bad'}]},{facts:[{kind:'package',externalReference:' PKG-1 '}]},{facts:[{kind:'package',externalReference:'PKG-1',parentReference:' parent '}]}])expect(()=>parseReferenceObservation(envelope('bad','000045',extra))).toThrow();
 });
 it('keeps an older open issue visible and blocks closing a record behind 500 newer resolved issues',async()=>{
  const at=clock.now().toISOString();
  await opened.db.query("INSERT INTO record_issues(id,proof_id,category,severity,title,subject_id,rule_version,compared_sources,created_at) SELECT 'regression-issue-'||i,$1,'fixture','warning','Regression issue',$1,'fixture/v1','{}',$2::timestamptz+make_interval(secs=>i) FROM generate_series(0,500) i",[proof,at]);
  await opened.db.query("INSERT INTO record_issue_actions(id,issue_id,action,reason,actor_user_id,created_at) SELECT 'regression-action-'||i,'regression-issue-'||i,'resolve','Fixture resolved',$1,$2 FROM generate_series(1,500) i",[owner,at]);
  const issues=await readRecordIssues(opened.db,proof);expect(issues.some(i=>i.id==='regression-issue-0'&&i.status==='open')).toBe(true);
  const detail=await getRecord(opened.db,clock,await workspace(),proof);expect(detail.record.issueCount).toBe(3);
  await expect(changeRecordLifecycle(opened.db,clock,await workspace(),proof,'close',{reason:'Should fail with old issue'})).rejects.toMatchObject({code:'RECORD_HAS_OPEN_REQUIREMENTS'});
 });
});
