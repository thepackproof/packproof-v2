import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {createTransaction} from '../src/domain/transactions.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
import {createOrganization,setOrganizationEntitlement,addOrganizationMember,revokeOrganizationMember,createServicePrincipal,issuePartnerCredential,authenticatePartner} from '../src/platform/organizations.js';
import {requireRecordWorkspace,type RecordWorkspace} from '../src/records/access.js';
import {recordCommand,addRecordEntity,readRecordIssues,readRecordRequirements,createRecordIssue,resolveRecordEntityReference,changeRecordLifecycle} from '../src/records/service.js';
import {publishRequirementTemplate,listRequirementTemplates,assignRequirementTemplate} from '../src/records/requirement-templates.js';
import {assignRecordIssue,listRecordReviewers} from '../src/records/issue-assignments.js';
import {evaluateQuantities,quantity,normalizeQuantityComparison,normalizeItemAllocation} from '../src/records/quantities.js';
import type {AppDependencies} from '../src/app.js';
let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,deps:AppDependencies,w:RecordWorkspace,other:RecordWorkspace,reviewer:RecordWorkspace,operator:RecordWorkspace,member:string,service:RecordWorkspace,unscoped:RecordWorkspace,nonce=0;
const clock={now:()=>new Date('2026-11-04T12:00:00Z')};
const source={system:'Warehouse export',reference:'000045',reportedAt:'2026-11-04T11:00:00Z'};
const definition={name:'Loading source documents',rules:[{key:'loading',stage:'loading',title:'Loading source document',acceptedEvidenceTypes:['SOURCE_ARTIFACT'],gracePeriodMs:0}]};
async function proof(){const t=await createTransaction(opened.db,clock,w.userId,{itemTitle:'Source-bound review'}),p=(await createOrGetProof(opened.db,clock,w.userId,t.transactionId,{participationPolicy:'COUNTERPARTY_OPTIONAL'})).proofId;await opened.db.query('INSERT INTO platform_proof_ownership(proof_id,merchant_id,environment,operator_membership_id,origin_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',[p,w.organizationId,w.environment,w.membershipId,w.userId,clock.now().toISOString()]);return p;}
async function revision(p:string){return Number((await opened.db.query<{revision:number}>('SELECT revision FROM record_state WHERE proof_id=$1',[p])).rows[0]?.revision??1);}
async function command(p:string,body:unknown,fn:(tx:typeof opened.db,current:RecordWorkspace)=>Promise<any>,actor=w,key='command-'+(++nonce),version?:number){return recordCommand(opened.db,clock,actor,p,'continuation:'+p,key,'"'+(version??await revision(p))+'"',body,fn);}
beforeAll(async()=>{
 vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED','true');opened=await openIsolatedTestDatabase();await migrate(opened.db);const admin=await insertUser(opened.db,clock);
 await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
 async function merchant(name:string){const user=await insertUser(opened.db,clock),org=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name,ownerUserId:user},'setup')).id;await setOrganizationEntitlement(opened.db,clock,admin,org,{enabled:true},'setup');return requireRecordWorkspace(opened.db,user,org,'sandbox');}
 w=await merchant('Review continuation');other=await merchant('Separate review organization');
 async function person(role:string){const user=await insertUser(opened.db,clock),m=await addOrganizationMember(opened.db,clock,w.userId,w.organizationId,{userId:user,role},'setup');return {id:String(m.id),workspace:await requireRecordWorkspace(opened.db,user,w.organizationId,'sandbox')};}
 const p=await person('REVIEWER');reviewer=p.workspace;member=p.id;operator=(await person('OPERATOR')).workspace;
 async function machine(scopes:string[]){const principal=await createServicePrincipal(opened.db,clock,w.userId,w.organizationId,{name:'Review routing'},'setup'),c=await issuePartnerCredential(opened.db,clock,w.userId,w.organizationId,principal.id,{scopes,expiresAt:'2026-11-05T12:00:00Z'},'setup'),actor=await authenticatePartner(opened.db,clock,'Bearer '+c.token,w.organizationId,undefined,'test');return {...w,userId:actor.actorUserId,membershipId:'',role:'OPERATOR' as const,partner:actor,authorizationClock:clock};}
 service=await machine(['proofs:read','proofs:write','issues:assign']);unscoped=await machine(['proofs:read','proofs:write']);deps={db:opened.db,clock} as AppDependencies;
},90000);
afterAll(async()=>{await opened?.close();vi.unstubAllEnvs();});
it('publishes immutable requirement versions with stable retries, canonical digests and current administrator authority',async()=>{
 const body={expectedVersion:0,definition},first=await publishRequirementTemplate(deps,w,'first',body);
 expect((await publishRequirementTemplate(deps,w,'first',body)).replayed).toBe(true);
 await expect(publishRequirementTemplate(deps,w,'first',{...body,definition:{...definition,name:'Changed'}})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 await expect(publishRequirementTemplate(deps,w,'stale',{...body,templateId:first.value.templateId})).rejects.toMatchObject({code:'TEMPLATE_VERSION_CONFLICT'});
 await expect(publishRequirementTemplate(deps,other,'cross',{...body,templateId:first.value.templateId,expectedVersion:1})).rejects.toMatchObject({code:'TEMPLATE_NOT_FOUND'});
 await expect(publishRequirementTemplate(deps,operator,'operator',body)).rejects.toMatchObject({code:'RECORD_PERMISSION_DENIED'});
 await expect(listRequirementTemplates(deps,service)).rejects.toMatchObject({code:'HUMAN_AUTHENTICATION_REQUIRED'});
 await expect(opened.db.query('UPDATE record_requirement_templates SET version=2 WHERE template_id=$1',[first.value.templateId])).rejects.toThrow(/IMMUTABLE/);
 expect((await opened.db.query('SELECT * FROM policy_recovery_events WHERE table_name=$1 AND after_json->>\'template_id\'=$2',['record_requirement_templates',first.value.templateId])).rows).toHaveLength(1);
});
it('assigns exactly the reviewed version atomically and retains earlier requirements after later publication',async()=>{
 const p=await proof(),published=(await publishRequirementTemplate(deps,w,'assignment-template',{expectedVersion:0,definition})).value;
 const input={templateId:published.templateId,version:1,definitionSha256:published.definitionSha256,subjectId:p,dueAt:'2026-11-03T12:00:00Z',reason:'Reviewed loading requirements'};
 await expect(assignRequirementTemplate(deps,w,p,'wrong-digest','"1"',{...input,definitionSha256:'a'.repeat(64)})).rejects.toMatchObject({code:'TEMPLATE_VERSION_CONFLICT'});
 await expect(assignRequirementTemplate(deps,w,p,'wrong-subject','"1"',{...input,subjectId:'another-record'})).rejects.toMatchObject({code:'RECORD_SUBJECT_NOT_FOUND'});
 expect((await opened.db.query('SELECT * FROM record_requirements WHERE proof_id=$1',[p])).rows).toHaveLength(0);
 const first=await assignRequirementTemplate(deps,w,p,'assign','"1"',input);expect(first.value.revision).toBe(2);
 expect((await assignRequirementTemplate(deps,w,p,'assign','"1"',input)).replayed).toBe(true);
 await expect(assignRequirementTemplate(deps,w,p,'duplicate','"2"',input)).rejects.toMatchObject({code:'TEMPLATE_ALREADY_ASSIGNED'});
 await publishRequirementTemplate(deps,w,'new-version',{templateId:published.templateId,expectedVersion:1,definition:{...definition,rules:[{...definition.rules[0],title:'Revised requirement'}]}});
 const requirements=await readRecordRequirements(opened.db,clock,p);expect(requirements[0]).toMatchObject({title:'Loading source document',status:'missing'});expect(requirements[0].templateVersion).toContain(published.definitionSha256);
 const preserved=JSON.parse((await opened.db.query<{canonical_json:string}>('SELECT canonical_json FROM recovery_events WHERE operation_id=$1',['requirement-assignment:'+first.value.id])).rows[0].canonical_json);
 expect(preserved.payload.rows.record_requirement_templates[0].definition_sha256).toBe(published.definitionSha256);
 await expect(command(p,{reason:'Not complete'},(tx,current)=>changeRecordLifecycle(tx,clock,current,p,'close',{reason:'Not complete'}))).rejects.toMatchObject({code:'RECORD_HAS_OPEN_REQUIREMENTS'});
});
it.each([
 [{amount:'0.3',unit:'kg'},[{amount:'0.1',unit:'kg'},{amount:'200',unit:'g'}]],
 [{amount:'1',unit:'lb'},[{amount:'453.59237',unit:'g'}]],
 [{amount:'1',unit:'ft'},[{amount:'12',unit:'in'}]],
 [{amount:'1',unit:'dozen'},[{amount:'12',unit:'each'}]],
 [{amount:'1',unit:'L'},[{amount:'1000',unit:'mL'}]],
])('uses exact decimal unit conversion (%j)',(expected,observed)=>{expect(evaluateQuantities(expected,observed)).toMatchObject({outcome:'within_tolerance',absoluteDifference:{numerator:'0',denominator:'1'},physicalCondition:'not_established'});});
it('honors the inclusive tolerance boundary and never guesses unknown units or dimensions',()=>{
 const policy={absolute:{amount:'1',unit:'g'},relativePpm:0};
 expect(evaluateQuantities({amount:'1',unit:'kg'},[{amount:'1001',unit:'g'}],policy).outcome).toBe('within_tolerance');
 expect(evaluateQuantities({amount:'1',unit:'kg'},[{amount:'1001.000000001',unit:'g'}],policy).outcome).toBe('different');
 for(const unit of ['L','case','constructor','__proto__'])expect(evaluateQuantities({amount:'1',unit:'kg'},[{amount:'1',unit}]).outcome).toBe('not_comparable');
 expect(evaluateQuantities({amount:'1000',unit:'each'},[{amount:'1001.5',unit:'each'}],{absolute:{amount:'1',unit:'each'},relativePpm:1500})).toMatchObject({outcome:'within_tolerance',allowedDifference:{numerator:'3',denominator:'2'}});
 expect(evaluateQuantities({amount:'0',unit:'kg'},[{amount:'1',unit:'kg'}]).outcome).toBe('different');
});
it.each(['1e3','1,000','-1','NaN','Infinity','9999999999999','0.0000000001',1,null])('rejects unbounded or ambiguous quantity input (%j)',amount=>{expect(()=>quantity({amount,unit:'each'})).toThrow(/decimal string/);});
it('requires attributed source times and explicit unique handling-unit allocations',()=>{
 const assertion={quantity:{amount:'10',unit:'each'},source};
 expect(()=>normalizeQuantityComparison({schema:'packproof.quantity-comparison/v1',expected:{...assertion,source:{...source,reportedAt:'2026-11-04T08:00:00'}},observed:assertion})).toThrow(/time zone/);
 const row={handlingUnitId:'package-a',quantity:{amount:'4',unit:'each'},source};
 expect(()=>normalizeItemAllocation({schema:'packproof.item-allocation/v1',ordered:assertion,allocations:[row,row]})).toThrow(/one explicit allocation/);
});
it('retains split item allocations and ambiguous references without allowing cross-record links or correction forks',async()=>{
 const p=await proof();async function append(body:unknown){return (await command(p,body,(tx,current)=>addRecordEntity(tx,clock,current,p,body))).value;}
 const a=await append({kind:'package',externalReference:'box-a',reason:'Source package'}),b=await append({kind:'pallet',externalReference:'pallet-b',reason:'Source pallet'});
 const allocation={schema:'packproof.item-allocation/v1',sku:'000045',ordered:{quantity:{amount:'10',unit:'each'},source},allocations:[{handlingUnitId:a.id,quantity:{amount:'4',unit:'each'},source},{handlingUnitId:b.id,quantity:{amount:'5',unit:'each'},source}]};
 const item=await append({kind:'item',externalReference:'line-000045',attributes:{itemAllocation:allocation},reason:'Preserve the reported split'});
 expect((await readRecordIssues(opened.db,p))[0]).toMatchObject({category:'quantity_mismatch',subjectId:item.id,ruleVersion:'packproof.quantity-comparison/v1'});
 await expect(append({kind:'item',attributes:{itemAllocation:{...allocation,allocations:[{...allocation.allocations[0],handlingUnitId:'unrelated-package'}]}},reason:'Wrong package'})).rejects.toMatchObject({code:'RECORD_SUBJECT_NOT_FOUND'});
 expect((await resolveRecordEntityReference(opened.db,w,p,'line-000045')).automaticMatch).toBe(item.id);
 await append({kind:'item',externalReference:'line-000045',reason:'Separate source assertion'});
 expect(await resolveRecordEntityReference(opened.db,w,p,'line-000045')).toMatchObject({outcome:'ambiguous',automaticMatch:null});
 await expect(resolveRecordEntityReference(opened.db,other,p,'line-000045')).rejects.toMatchObject({code:'PROOF_NOT_FOUND'});
 await append({kind:'item',externalReference:'corrected-line',supersedesId:item.id,reason:'Correct reference'});
 await expect(append({kind:'item',supersedesId:item.id,reason:'Cannot branch'})).rejects.toMatchObject({code:'ENTITY_ALREADY_SUPERSEDED'});
 expect((await opened.db.query('SELECT id FROM record_entities WHERE id=$1',[item.id])).rows).toHaveLength(1);
});
it('assigns only eligible reviewers, requires a dedicated machine scope and preserves actor attribution without resolving the issue',async()=>{
 const p=await proof(),issue=await createRecordIssue(opened.db,clock,p,{category:'source_conflict',severity:'warning',title:'Review source conflict',subjectId:p,ruleVersion:'fixture/v1',comparedSources:{one:'a',two:'b'}});
 const people=(await listRecordReviewers(opened.db,clock,w,p)).reviewers;expect(people.some(r=>r.membershipId===member)).toBe(true);expect(people.some(r=>r.membershipId===operator.membershipId)).toBe(false);
 async function assign(actor:RecordWorkspace,key:string,body:unknown,version?:number){return command(p,body,(tx,current)=>assignRecordIssue(tx,clock,current,p,issue,body),actor,key,version);}
 await expect(assign(w,'wrong-person',{membershipId:operator.membershipId,reason:'Cannot read this record'})).rejects.toMatchObject({code:'ISSUE_REVIEWER_UNAVAILABLE'});
 const body={membershipId:member,reason:'Review the loading document'},first=await assign(w,'assign',body);
 expect((await assign(w,'assign',body,1)).replayed).toBe(true);
 await expect(assign(unscoped,'missing-scope',{membershipId:null,reason:'Missing dedicated scope'})).rejects.toMatchObject({code:'INSUFFICIENT_SCOPE'});
 await assign(service,'machine',body);
 expect((await readRecordIssues(opened.db,p))[0]).toMatchObject({status:'open',assignment:{membershipId:member,userId:reviewer.userId,assignedBy:service.userId}});
 const preserved=JSON.parse((await opened.db.query<{canonical_json:string}>('SELECT canonical_json FROM recovery_events WHERE operation_id=$1',['issue-assignment:'+first.value.id])).rows[0].canonical_json);
 expect(preserved.payload.rows.record_issue_assignments).toHaveLength(1);
 await revokeOrganizationMember(opened.db,clock,w.userId,w.organizationId,member,'setup');expect((await readRecordIssues(opened.db,p))[0].assignment?.membershipActive).toBe(false);
 await expect(assign(w,'revoked',body)).rejects.toMatchObject({code:'ISSUE_REVIEWER_UNAVAILABLE'});
 await assign(w,'clear',{membershipId:null,reason:'Awaiting another eligible reviewer'});
 expect((await readRecordIssues(opened.db,p))[0]).toMatchObject({status:'open',assignment:{membershipId:null}});
 await expect(opened.db.query('DELETE FROM record_issue_assignments WHERE issue_id=$1',[issue])).rejects.toThrow(/IMMUTABLE/);
});
