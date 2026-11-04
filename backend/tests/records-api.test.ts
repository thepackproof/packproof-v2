import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import express from 'express';
import {rateLimit} from 'express-rate-limit';
import request from './in-process-http.js';
import {randomBytes} from 'node:crypto';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {createTransaction} from '../src/domain/transactions.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
import {createOrganization,setOrganizationEntitlement,addOrganizationMember,revokeOrganizationMember,createServicePrincipal,issuePartnerCredential,authenticatePartner,revokePartnerCredential,createDelegation} from '../src/platform/organizations.js';
import {BearerUserAdapter} from '../src/auth/adapter.js';
import {createRecordsRouter,createPartnerRecordsRouter} from '../src/records/router.js';
import {requireRecordWorkspace,requireRecordAccess} from '../src/records/access.js';
import {listRecords,getRecord,recordCommand,patchRecord,addRequirement,waiveRequirement,changeRecordLifecycle,addRecordEntity,actOnIssue,appendAmendment,readRecordRequirements,safeRecordData,pageRecordTimeline,pageRecordEvidence,reviewRecord} from '../src/records/service.js';
import type {AppDependencies} from '../src/app.js';
import type {RecordWorkspace} from '../src/records/access.js';
import {DomainError} from '../src/domain/errors.js';

describe('organization records preserve canonical Proofs and current access',()=>{
  let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,app:ReturnType<typeof express>;
  const clock={now:()=>new Date()};
  let admin:string,owner:string,other:string,operator:string,reviewer:string,org:string,otherOrg:string,opMember:string,reviewMember:string;
  let a:string,b:string,otherProof:string,workspace:RecordWorkspace;
  const scope=()=>({organizationId:org,environment:'sandbox'});
  beforeAll(async()=>{
    vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED','true');vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY',randomBytes(32).toString('base64'));
    opened=await openIsolatedTestDatabase();await migrate(opened.db);
    [admin,owner,other,operator,reviewer]=await Promise.all(Array.from({length:5},()=>insertUser(opened.db,clock)));
    await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
    org=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Warehouse A',ownerUserId:owner},'setup')).id;
    otherOrg=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Warehouse B',ownerUserId:other},'setup')).id;
    for(const id of [org,otherOrg])await setOrganizationEntitlement(opened.db,clock,admin,id,{enabled:true},'setup');
    opMember=String((await addOrganizationMember(opened.db,clock,owner,org,{userId:operator,role:'OPERATOR'},'setup')).id);
    reviewMember=String((await addOrganizationMember(opened.db,clock,owner,org,{userId:reviewer,role:'REVIEWER'},'setup')).id);
    workspace=await requireRecordWorkspace(opened.db,owner,org,'sandbox');
    async function proof(user:string,organizationId:string,title:string){
      const transaction=await createTransaction(opened.db,clock,user,{itemTitle:title,quantity:2,shipping:{trackingNumber:'00001234',carrier:'Example'}});
      const p=await createOrGetProof(opened.db,clock,user,transaction.transactionId,{participationPolicy:'COUNTERPARTY_OPTIONAL'});
      const w=await requireRecordWorkspace(opened.db,user,organizationId,'sandbox');
      await opened.db.query('INSERT INTO platform_proof_ownership(proof_id,merchant_id,environment,operator_membership_id,origin_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',[p.proofId,organizationId,'sandbox',w.membershipId,user,clock.now().toISOString()]);
      await opened.db.query('INSERT INTO api_tenant_proofs(tenant_id,external_id,proof_id,request_hash,created_at) VALUES($1,$2,$3,$4,$5)',[w.tenantId,p.proofId,p.proofId,'fixture',clock.now().toISOString()]);
      return p.proofId;
    }
    a=await proof(owner,org,'Expected cartons');b=await proof(operator,org,'Second shipment');otherProof=await proof(other,otherOrg,'Secret tenant shipment');
    const deps={db:opened.db,clock,auth:new BearerUserAdapter(opened.db),devAuth:true,testFixtures:true} as AppDependencies;
    app=express();app.use(express.json());app.use('/me/records',createRecordsRouter(deps));
    app.use((e:unknown,_r:express.Request,s:express.Response,_n:express.NextFunction)=>{if(e instanceof DomainError)s.status(e.httpStatus).json({code:e.code});else s.status(500).json({error:String(e)});});
  },90000);
  afterAll(async()=>{await opened?.close();vi.unstubAllEnvs();});
  const cmd=<T>(id:string,operation:string,key:string,revision:number,body:unknown,fn:Parameters<typeof recordCommand<T>>[8])=>recordCommand(opened.db,clock,workspace,id,operation,key,`"${revision}"`,body,fn);

  it('returns only current organizations and supports a useful pending context',async()=>{
    const r=await request(app).get('/me/records/context').set('Authorization',`Bearer ${owner}`);expect(r.status,r.text).toBe(200);
    expect(r.body.organizations.map((o:any)=>o.id)).toEqual([org]);expect(r.body.capabilities.records).toBe(true);
    vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED','false');
    const pending=await request(app).get('/me/records/context').set('Authorization',`Bearer ${owner}`);expect(pending.status).toBe(200);expect(pending.body.capabilities.records).toBe(false);
    vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED','true');
  });
  it('scopes rows, cohort counts, exact identifiers and direct reads before projection',async()=>{
    const r=await request(app).get('/me/records').query({...scope(),q:'00001234'}).set('Authorization',`Bearer ${owner}`);
    expect(r.status,r.text).toBe(200);expect(r.body.counts.total).toBe(2);expect(r.body.counts.policyComplete).toBe(0);expect(r.body.records.map((p:any)=>p.id).sort()).toEqual([a,b].sort());
    expect((await request(app).get(`/me/records/${otherProof}`).query(scope()).set('Authorization',`Bearer ${owner}`)).status).toBe(404);
    expect((await request(app).get('/me/records').query({organizationId:otherOrg,environment:'sandbox'}).set('Authorization',`Bearer ${owner}`)).status).toBe(404);
    expect((await request(app).get('/me/records').query({organizationId:org,environment:'live'}).set('Authorization',`Bearer ${owner}`)).status).toBe(404);
    const op=await requireRecordWorkspace(opened.db,operator,org,'sandbox');expect((await listRecords(opened.db,clock,op)).records.map(p=>p.id)).toEqual([b]);
    await expect(requireRecordAccess(opened.db,op,a)).rejects.toMatchObject({code:'PROOF_NOT_FOUND'});
  });
  it('signs list cursors against the complete authorized filter scope',async()=>{
    const one=await listRecords(opened.db,clock,workspace,{limit:1});expect(one.records).toHaveLength(1);expect(one.nextCursor).toBeTruthy();
    const two=await listRecords(opened.db,clock,workspace,{limit:1,cursor:one.nextCursor});expect(two.records).toHaveLength(1);expect(two.records[0].id).not.toBe(one.records[0].id);
    await expect(listRecords(opened.db,clock,workspace,{limit:1,cursor:one.nextCursor,q:'00001234'})).rejects.toMatchObject({code:'INVALID_CURSOR'});
    await expect(listRecords(opened.db,clock,workspace,{limit:1,cursor:`${one.nextCursor}x`})).rejects.toMatchObject({code:'INVALID_CURSOR'});
  });
  it('commits metadata, reason, revision, replay result and stream event atomically',async()=>{
    const body={title:'Updated operational title',reason:'Correct display title'};
    const first=await cmd(a,'patch','metadata-one',1,body,(tx,w)=>patchRecord(tx,clock,w,a,body));
    expect(first.value.revision).toBe(2);expect(first.replayed).toBe(false);
    const replay=await cmd(a,'patch','metadata-one',1,body,(tx,w)=>patchRecord(tx,clock,w,a,body));expect(replay).toEqual({...first,replayed:true});
    expect((await opened.db.query('SELECT item_title FROM transactions t JOIN proofs p ON p.transaction_id=t.id WHERE p.id=$1',[a])).rows[0].item_title).toBe('Expected cartons');
    expect((await opened.db.query("SELECT o.id FROM proof_outbox o JOIN api_event_stream s ON s.event_id=o.id WHERE o.proof_id=$1 AND o.event_type='record.updated'",[a])).rows).toHaveLength(1);
    await expect(cmd(a,'patch','metadata-one',1,{...body,title:'Different'},(tx,w)=>patchRecord(tx,clock,w,a,body))).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    await expect(cmd(a,'patch','metadata-stale',1,body,(tx,w)=>patchRecord(tx,clock,w,a,body))).rejects.toMatchObject({code:'REVISION_CONFLICT'});
    expect((await getRecord(opened.db,clock,workspace,a)).record.revision).toBe(2);
  });
  it('distinguishes not-yet-due, missing and waived requirements, and keeps close separate from finalization',async()=>{
    const future={title:'Handoff photograph',stage:'handoff',templateVersion:'pickup/v1',acceptedEvidenceTypes:['HANDOFF_PHOTO'],dueAt:new Date(Date.now()+3600000).toISOString(),reason:'Apply pilot pickup template'};
    const added=await cmd(a,'requirement','requirement-future',2,future,(tx,w)=>addRequirement(tx,clock,w,a,future));
    const requirements=await readRecordRequirements(opened.db,clock,a);expect(requirements[0].status).toBe('not_yet_due');
    await expect(cmd(a,'close','close-premature',3,{reason:'Close'},(tx,w)=>changeRecordLifecycle(tx,clock,w,a,'close',{reason:'Close'}))).rejects.toMatchObject({code:'RECORD_HAS_OPEN_REQUIREMENTS'});
    await cmd(a,'waive','waive-one',3,{reason:'Handoff is outside this test workflow'},(tx,w)=>waiveRequirement(tx,clock,w,a,added.value.id,{reason:'Handoff is outside this test workflow'}));
    expect((await readRecordRequirements(opened.db,clock,a))[0].status).toBe('waived');
    await cmd(a,'close','close-one',4,{reason:'Reviewed available record'},(tx,w)=>changeRecordLifecycle(tx,clock,w,a,'close',{reason:'Reviewed available record'}));
    const detail=await getRecord(opened.db,clock,workspace,a);expect(detail.record.lifecycle).toBe('closed');expect(detail.record.integrity).toBe('not_sealed');
    expect((await opened.db.query('SELECT status,manifest_id FROM proofs WHERE id=$1',[a])).rows[0]).toMatchObject({status:'READY_FOR_EVIDENCE',manifest_id:null});
  });
  it('evaluates child evidence gaps without treating a record-level artifact as child evidence',async()=>{
    const entityBody={kind:'package',externalReference:'PKG-01',attributes:{expectedQuantity:3,observedQuantity:2,expectedSource:'Pick list',observedSource:'Loading scan',units:'pieces'},reason:'Record loading observation'};
    const entity=await cmd(b,'entity','package-one',1,entityBody,(tx,w)=>addRecordEntity(tx,clock,w,b,entityBody));
    const req={subjectId:entity.value.id,title:'Package handoff photo',stage:'handoff',templateVersion:'package/v1',acceptedEvidenceTypes:['HANDOFF_PHOTO'],dueAt:new Date(Date.now()-60000).toISOString(),reason:'Require the package photograph'};
    await cmd(b,'requirement','child-requirement',2,req,(tx,w)=>addRequirement(tx,clock,w,b,req));
    const detail=await getRecord(opened.db,clock,workspace,b);expect(detail.record.coverage.missing).toBe(1);expect(detail.requirements[0].subjectId).toBe(entity.value.id);expect(detail.record.issueCount).toBe(1);
    const issue=detail.issues[0];expect(issue.comparedSources.expected.source).toBe('Pick list');expect(issue.status).toBe('open');
    const action={action:'resolve',reason:'The source confirmed one unit was held for a later shipment'};
    await cmd(b,'issue','resolve-one',3,action,(tx,w)=>actOnIssue(tx,clock,w,b,issue.id,action));
    const after=await getRecord(opened.db,clock,workspace,b);expect(after.issues[0].status).toBe('resolved');expect(after.issues[0].comparedSources).toEqual(issue.comparedSources);expect(after.issues[0].actions[0].reason).toBe(action.reason);
  });
  it('append-only corrections retain previous assertions and reject crossed targets',async()=>{
    const detail=await getRecord(opened.db,clock,workspace,b),entity=detail.relationships[0];
    const body={supersedesId:entity.id,assertion:{observedQuantity:3,source:'Corrected loading count'},reason:'Operator corrected the count'};
    await cmd(b,'amendment','amend-one',4,body,(tx,w)=>appendAmendment(tx,clock,w,b,body));
    expect((await opened.db.query('SELECT attributes FROM record_entities WHERE id=$1',[entity.id])).rows[0].attributes).toMatchObject({observedQuantity:2});
    await expect(cmd(a,'amendment','cross-amend',5,body,(tx,w)=>appendAmendment(tx,clock,w,a,body))).rejects.toMatchObject({code:'ASSERTION_NOT_FOUND'});
  });
  it('withholds read-only mutations and rechecks revoked authority before cached replies',async()=>{
    const readOnly=await requireRecordWorkspace(opened.db,reviewer,org,'sandbox');
    await expect(recordCommand(opened.db,clock,readOnly,a,'patch','denied','"5"',{title:'No',reason:'No'},(tx,w)=>patchRecord(tx,clock,w,a,{title:'No',reason:'No'}))).rejects.toMatchObject({code:'RECORD_PERMISSION_DENIED'});
    await revokeOrganizationMember(opened.db,clock,owner,org,reviewMember,'revoke');
    await expect(getRecord(opened.db,clock,readOnly,a)).rejects.toMatchObject({code:'ORGANIZATION_NOT_FOUND'});
  });
  it('retains the service credential boundary, scope and revocation during record replay',async()=>{
    const principal=(await createServicePrincipal(opened.db,clock,owner,org,{name:'Operational test connector'},'test')).id;
    const issued=await issuePartnerCredential(opened.db,clock,owner,org,principal,{scopes:['proofs:read','proofs:write'],expiresAt:new Date(Date.now()+86400000).toISOString()},'test');
    const partnerApp=express();partnerApp.use(express.json());
    // This isolated HTTP adapter also bounds its synthetic authentication path.
    partnerApp.use(rateLimit({windowMs:60_000,limit:1000,keyGenerator:()=> 'records-fixture'}));
    partnerApp.use(async(r,s,n)=>{try{(r as any).partnerActor=await authenticatePartner(opened.db,clock,r.header('Authorization'),r.header('PackProof-Merchant-Id'),undefined,'test');n();}catch(e){n(e);}});
    partnerApp.use('/v1/partner',createPartnerRecordsRouter({db:opened.db,clock} as AppDependencies));
    partnerApp.use((e:unknown,_r:express.Request,s:express.Response,_n:express.NextFunction)=>{if(e instanceof DomainError)s.status(e.httpStatus).json({code:e.code});else s.status(500).json({error:String(e)});});
    const headers={Authorization:`Bearer ${issued.token}`,'PackProof-Merchant-Id':org};
    const detail=await request(partnerApp).get(`/v1/partner/proofs/${a}/record`).set(headers);
    expect(detail.status,detail.text).toBe(200);expect(detail.body.record.proofId).toBe(a);expect(detail.body.capabilities.capture).toBe(false);expect(detail.body.capabilities.waive).toBe(false);
    const body={reason:'Additional source evidence is expected'},mutationHeaders={...headers,'Idempotency-Key':'partner-reopen','If-Match':'"5"'};
    const reopened=await request(partnerApp).post(`/v1/partner/proofs/${a}/reopen`).set(mutationHeaders).send(body);expect(reopened.status,reopened.text).toBe(200);expect(reopened.body.revision).toBe(6);
    const replay=await request(partnerApp).post(`/v1/partner/proofs/${a}/reopen`).set(mutationHeaders).send(body);expect(replay.body).toEqual(reopened.body);expect(replay.headers['idempotency-replayed']).toBe('true');
    await revokePartnerCredential(opened.db,clock,owner,org,issued.id,'test');
    expect((await request(partnerApp).post(`/v1/partner/proofs/${a}/reopen`).set(mutationHeaders).send(body)).status).toBe(401);
  });
  it('records deliberate human review without creating a signature or attestation',async()=>{
    const input={action:'mark_reviewed',reason:'Inspected the available source records'};
    const reviewed=await cmd(a,'review','review-one',6,input,(tx,w)=>reviewRecord(tx,clock,w,a,input));expect(reviewed.value.review).toBe('reviewed');
    const detail=await getRecord(opened.db,clock,workspace,a);expect(detail.record.review).toBe('reviewed');expect(detail.record.integrity).toBe('not_sealed');expect(detail.assurance.physicalCondition).toBe('not_established');
    expect((await opened.db.query('SELECT id FROM attestations WHERE proof_id=$1',[a])).rows).toHaveLength(0);
    expect(detail.capabilities.capture).toBe(true);
    expect((await getRecord(opened.db,clock,workspace,b)).capabilities.capture).toBe(false);
  });
  it('constrains location-scoped memberships in reads, search, counts and direct lookup',async()=>{
    const siteUser=await insertUser(opened.db,clock),siteMembership='member_site_fixture';
    await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4),($5,$2,$6,$4)',['site-a',org,'Site A',clock.now().toISOString(),'site-b','Site B']);
    await opened.db.query("INSERT INTO platform_memberships(id,organization_id,user_id,role,location_scoped,created_at) VALUES($1,$2,$3,'REVIEWER',true,$4)",[siteMembership,org,siteUser,clock.now().toISOString()]);
    await opened.db.query('INSERT INTO record_membership_locations(membership_id,organization_id,location_id) VALUES($1,$2,$3)',[siteMembership,org,'site-a']);
    await opened.db.query("UPDATE record_state SET location_id='site-a' WHERE proof_id=$1",[a]);
    await opened.db.query("UPDATE record_state SET location_id='site-b' WHERE proof_id=$1",[b]);
    const site=await requireRecordWorkspace(opened.db,siteUser,org,'sandbox'),page=await listRecords(opened.db,clock,site,{q:'00001234'});
    expect(page.records.map(r=>r.id)).toEqual([a]);expect(page.counts.total).toBe(1);
    await expect(getRecord(opened.db,clock,site,b)).rejects.toMatchObject({code:'PROOF_NOT_FOUND'});
    await expect(listRecords(opened.db,clock,site,{locationId:'site-b'})).rejects.toMatchObject({code:'LOCATION_NOT_FOUND'});
  });
  it('does not expose credential-like audit details or fabricated scene assurance',()=>{
    expect(safeRecordData({route:'safe',authorization:'Bearer secret',nested:{launchToken:'secret',reason:'shown'}})).toEqual({route:'safe',nested:{reason:'shown'}});
  });
  it('pages timeline and evidence independently with resource-bound cursors and no object keys',async()=>{
    const first=await pageRecordTimeline(opened.db,clock,workspace,b,{limit:2});expect(first.timeline).toHaveLength(2);expect(first.nextCursor).toBeTruthy();
    const next=await pageRecordTimeline(opened.db,clock,workspace,b,{limit:2,cursor:first.nextCursor});expect(next.timeline.some(e=>first.timeline.some(p=>p.id===e.id))).toBe(false);
    await expect(pageRecordTimeline(opened.db,clock,workspace,a,{limit:2,cursor:first.nextCursor})).rejects.toMatchObject({code:'INVALID_CURSOR'});
    for(const id of ['pending-page-a','pending-page-b'])await opened.db.query("INSERT INTO evidence(id,proof_id,submitted_by,object_key,content_type,validation_status,evidence_type,created_at) VALUES($1,$2,$3,$4,'image/jpeg','PENDING','FULFILLMENT_CAPTURE',$5)",[id,b,operator,`private/${id}`,clock.now().toISOString()]);
    const evidence=await pageRecordEvidence(opened.db,clock,workspace,b,{limit:1});expect(evidence.evidence).toHaveLength(1);expect(evidence.evidence[0].state).toBe('pending');expect(JSON.stringify(evidence)).not.toContain('private/');
    const more=await pageRecordEvidence(opened.db,clock,workspace,b,{limit:1,cursor:evidence.nextCursor});expect(more.evidence[0].id).not.toBe(evidence.evidence[0].id);expect(more.nextCursor).toBeNull();
  });
});
