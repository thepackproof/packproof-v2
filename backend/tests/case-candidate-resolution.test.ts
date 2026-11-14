import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import type {Database} from '../src/db/database.js';
import {applyOperationalObservation,type CaseWriteContext} from '../src/records/cases.js';
import type {TypedSourceObservation,TypedSourceReference} from '../src/records/source-contracts.js';

type Branch='legacy'|'mapped';
type Lookup={namespace?:string;type?:TypedSourceReference['type'];externalId:string;parent?:string};
const scope={organization:'candidate-org',environment:'sandbox',site:'candidate-site',operator:'candidate-operator'};
const clock={now:()=>new Date('2026-11-14T12:00:00Z')};
const baseline={
 mapped:`SELECT DISTINCT c.id FROM record_cases c LEFT JOIN record_case_entities e ON e.case_id=c.id WHERE c.organization_id=$1 AND c.environment=$2 AND c.location_id=$3 AND c.operator_membership_id=$4 AND ((c.root_namespace=$5 AND c.root_type=$6 AND c.root_external_id=$7 AND $8='') OR (e.namespace=$5 AND e.entity_type=$6 AND e.external_id=$7 AND e.parent_external_id=$8)) LIMIT 3`,
 legacy:`SELECT DISTINCT c.id FROM record_cases c LEFT JOIN record_case_entities e ON e.case_id=c.id WHERE c.organization_id=$1 AND c.environment=$2 AND c.location_id=$3 AND c.operator_membership_id=$7 AND ((c.root_namespace=$4 AND c.root_type=$5 AND c.root_external_id=$6) OR (e.namespace=$4 AND e.entity_type=$5 AND e.external_id=$6)) LIMIT 3`,
};

/** Capture the private lookup at its public domain entry, then stop before
 * materialization. Only the two lookup queries run against the SQL fixture.
 * Existing typed-allocation suites cover approved policy admission and writes. */
async function lookupSql(branch:Branch){
 const captured=new Error('captured candidate lookup');let sql='';
 const db:Database={transaction:async fn=>fn(db),query:async <T>(query:string)=>{
  if(query.includes('FROM record_cases c')&&query.includes('LIMIT 3')){sql=query;throw captured;}
  if(query.startsWith('SELECT pg_advisory_xact_lock')||query.includes('FROM record_case_crosswalks')||query.includes('SELECT p.* FROM record_case_row_projections'))return {rows:[],rowCount:0};
  if(query.includes('FROM record_case_identity_rules'))return {rows:[{id:'approved-exact-rule',left_namespace:'source',right_namespace:'target',rule_version:'fixture/1'}] as T[],rowCount:1};
  throw new Error(`Unexpected query before candidate lookup: ${query}`);
 }};
 const root={namespace:'source',type:'order' as const,externalId:'ROOT'};
 const observation:TypedSourceObservation={sourceEventId:'candidate-event',sourceRevision:'1',observationKind:'snapshot',occurredAt:null,sourceAsOf:'2026-11-12T12:00:00Z',timeQuality:'snapshot_time_only',references:[root],assertions:[{subjectReference:root,property:'status',value:'reported',sourceLocator:{row:1,field:'status'},assurance:'source_reported'}],relationships:[],supersedes:null,originSystem:null,copiedFromSource:null};
 const context:CaseWriteContext={organizationId:scope.organization,environment:'sandbox',locationId:scope.site,operatorMembershipId:scope.operator,actor:{} as CaseWriteContext['actor'],batchId:'candidate-batch',rowId:'candidate-row',rowNumber:1,receivedAt:clock.now().toISOString(),source:{schema:branch==='mapped'?'packproof.typed-source-batch/v2':'packproof.typed-source-batch/v1',connectionId:'candidate-connection',locationId:scope.site,sourceProfile:branch==='mapped'?'packproof.operational-observations/v2':'packproof.operational-observations/v1',mappingVersion:'fixture/1',sourceNamespace:'source',subscriptionId:'candidate-subscription',configurationRevision:1,grantRevision:2,wholeFileConsent:true,original:{name:'synthetic.json',mediaType:'application/json',content:'[]',sha256:'0'.repeat(64)},mapping:{},constants:{},completeness:{kind:'unknown',asOf:null,marker:null},headers:[],rows:[]},...(branch==='mapped'?{casePolicy:{schema:'packproof.cross-case-source-policy/v1',version:'fixture/1',allowMultiOrderRows:true,partitionRule:'explicit_order_line_allocations',sharedEntityTypes:['load'],sourceOwnerQualified:true,qualificationReference:'Synthetic lookup fixture'}}:{})};
 await expect(applyOperationalObservation(db,clock,context,observation)).rejects.toBe(captured);expect(sql).not.toBe('');return sql;
}

describe('exact case candidate root and retained-entity lookup sets',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,queries:Record<Branch,string>,entitySequence=0;
 const params=(branch:Branch,value:Lookup)=>branch==='mapped'?[scope.organization,scope.environment,scope.site,scope.operator,value.namespace??'source',value.type??'order',value.externalId,value.parent??'']:[scope.organization,scope.environment,scope.site,value.namespace??'source',value.type??'order',value.externalId,scope.operator];
 const lookup=async(branch:Branch,value:Lookup,sql=queries[branch])=>(await opened.db.query<{id:string}>(sql,params(branch,value))).rows.map(r=>r.id).sort();
 async function addCase(id:string,root:string,overrides:Partial<typeof scope>={},namespace='source'){
  const s={...scope,...overrides};await opened.db.query(`INSERT INTO record_cases(id,organization_id,environment,location_id,location_key,operator_membership_id,root_namespace,root_type,root_external_id) VALUES($1,$2,$3,$4,$4,$5,$6,'order',$7)`,[id,s.organization,s.environment,s.site,s.operator,namespace,root]);
 }
 async function entity(caseId:string,type:string,externalId:string,parent='',namespace='source'){
  await opened.db.query(`INSERT INTO record_case_entities(id,case_id,organization_id,environment,namespace,entity_type,external_id,parent_external_id) SELECT $1,c.id,c.organization_id,c.environment,$3,$4,$5,$6 FROM record_cases c WHERE c.id=$2`,[`candidate-entity-${++entitySequence}`,caseId,namespace,type,externalId,parent]);
 }
 beforeAll(async()=>{
  vi.stubEnv('PACKPROOF_CROSS_CASE_ENABLED','true');opened=await openIsolatedTestDatabase();
  // Keep the production lookup constraints/index keys. No current assertions or
  // relationships are present: retained entity identities remain resolvable.
  await opened.db.query(`CREATE TABLE record_cases(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,environment TEXT NOT NULL,location_id TEXT NOT NULL,location_key TEXT NOT NULL CHECK(location_key=location_id),operator_membership_id TEXT NOT NULL,root_namespace TEXT NOT NULL,root_type TEXT NOT NULL CHECK(root_type IN ('order','shipment','return')),root_external_id TEXT NOT NULL,UNIQUE(id,organization_id,environment),UNIQUE(organization_id,environment,location_key,root_namespace,root_type,root_external_id))`);
  await opened.db.query(`CREATE TABLE record_case_entities(id TEXT PRIMARY KEY,case_id TEXT NOT NULL,organization_id TEXT NOT NULL,environment TEXT NOT NULL,namespace TEXT NOT NULL,entity_type TEXT NOT NULL,external_id TEXT NOT NULL,parent_external_id TEXT NOT NULL DEFAULT '',FOREIGN KEY(case_id,organization_id,environment) REFERENCES record_cases(id,organization_id,environment),UNIQUE(case_id,namespace,entity_type,external_id,parent_external_id))`);
  await opened.db.query('CREATE INDEX record_case_entity_lookup ON record_case_entities(organization_id,environment,namespace,entity_type,external_id,case_id)');
  queries={legacy:await lookupSql('legacy'),mapped:await lookupSql('mapped')};
  await addCase('root-and-entity','ROOT');await entity('root-and-entity','order','ROOT');await entity('root-and-entity','order','ROOT','retained-alternate-parent');
  await addCase('root-only','ROOT-ONLY');
  await addCase('entity-only','ENTITY-ROOT',{},'other');await entity('entity-only','shipment','ENTITY-SHIP');await entity('entity-only','return','RETAINED');await entity('entity-only','shipment','LEGACY-PARENT','retained-parent');
  await addCase('dual-root','DUAL');await entity('dual-root','order','DUAL');await addCase('dual-entity','OTHER-DUAL',{},'other');await entity('dual-entity','order','DUAL');
  for(let i=0;i<5;i++){await addCase(`ambiguous-${i}`,`AMBIGUOUS-ROOT-${i}`);await entity(`ambiguous-${i}`,'shipment','AMBIGUOUS');}
  await addCase('line-a','PARENT-A');await entity('line-a','order_line','004','PARENT-A');await addCase('line-b','PARENT-B');await entity('line-b','order_line','004','PARENT-B');
  await addCase('visible-scope','VISIBLE-ROOT');await entity('visible-scope','order','SCOPE-ROOT');await entity('visible-scope','shipment','SCOPE-ENTITY');
  const foreign=[{organization:'foreign-org'},{environment:'live'},{site:'foreign-site'},{operator:'foreign-operator'}];
  for(const [i,change] of foreign.entries()){await addCase(`foreign-root-${i}`,'SCOPE-ROOT',change);await addCase(`foreign-entity-${i}`,`FOREIGN-ENTITY-${i}`,change);await entity(`foreign-entity-${i}`,'shipment','SCOPE-ENTITY');}
 },30000);
 afterAll(async()=>{await opened?.close();vi.unstubAllEnvs();});

 it.each<Branch>(['legacy','mapped'])('%s resolves exact root-only and retained entity-only anchors and deduplicates both branches',async branch=>{
  expect(await lookup(branch,{externalId:'ROOT'})).toEqual(['root-and-entity']);expect(await lookup(branch,{externalId:'ROOT-ONLY'})).toEqual(['root-only']);
  expect(await lookup(branch,{type:'shipment',externalId:'ENTITY-SHIP'})).toEqual(['entity-only']);expect(await lookup(branch,{type:'return',externalId:'RETAINED'})).toEqual(['entity-only']);
  expect(await lookup(branch,{externalId:'ROOT',namespace:'unapproved-other'})).toEqual([]);expect(await lookup(branch,{type:'shipment',externalId:'ROOT'})).toEqual([]);
 });
 it.each<Branch>(['legacy','mapped'])('%s scopes root and entity branches to the exact organization, environment, site and operator',async branch=>{
  expect(await lookup(branch,{externalId:'SCOPE-ROOT'})).toEqual(['visible-scope']);expect(await lookup(branch,{type:'shipment',externalId:'SCOPE-ENTITY'})).toEqual(['visible-scope']);
 });
 it.each<Branch>(['legacy','mapped'])('%s preserves distinct-case ambiguity and the outer three-case cap',async branch=>{
  expect(await lookup(branch,{externalId:'DUAL'})).toEqual(['dual-entity','dual-root']);
  const capped=await lookup(branch,{type:'shipment',externalId:'AMBIGUOUS'});expect(capped).toHaveLength(3);expect(new Set(capped).size).toBe(3);expect(capped.every(id=>id.startsWith('ambiguous-'))).toBe(true);
 });
 it('keeps namespace-mapped exact line parents and the empty-parent root guard',async()=>{
  expect(await lookup('mapped',{type:'order_line',externalId:'004',parent:'PARENT-A'})).toEqual(['line-a']);expect(await lookup('mapped',{type:'order_line',externalId:'004',parent:'PARENT-B'})).toEqual(['line-b']);
  expect(await lookup('mapped',{type:'order_line',externalId:'004',parent:'WRONG'})).toEqual([]);expect(await lookup('mapped',{externalId:'ROOT-ONLY',parent:'not-empty'})).toEqual([]);
 });
 it('retains legacy root-type entity matching without adding a parent filter',async()=>{
  expect(await lookup('legacy',{type:'shipment',externalId:'LEGACY-PARENT'})).toEqual(['entity-only']);expect(await lookup('mapped',{type:'shipment',externalId:'LEGACY-PARENT'})).toEqual([]);
  expect(await lookup('mapped',{type:'shipment',externalId:'LEGACY-PARENT',parent:'retained-parent'})).toEqual(['entity-only']);
 });
 it.each<Branch>(['legacy','mapped'])('%s matches the previous LEFT JOIN lookup result sets across the bounded fixture',async branch=>{
  const values:Lookup[]=[{externalId:'ROOT'},{externalId:'ROOT-ONLY'},{externalId:'DUAL'},{type:'shipment',externalId:'ENTITY-SHIP'},{type:'return',externalId:'RETAINED'},{externalId:'SCOPE-ROOT'},{type:'shipment',externalId:'SCOPE-ENTITY'},{externalId:'ABSENT'},{type:'shipment',externalId:'LEGACY-PARENT'},{type:'order_line',externalId:'004',parent:'PARENT-A'},{type:'order_line',externalId:'004',parent:'PARENT-B'},{type:'order_line',externalId:'004',parent:'WRONG'},{externalId:'ROOT-ONLY',parent:'not-empty'}];
  for(const value of values)expect(await lookup(branch,value),JSON.stringify(value)).toEqual(await lookup(branch,value,baseline[branch]));
  // LIMIT without ORDER BY deliberately does not promise which three ambiguous
  // IDs survive. Both queries must preserve three distinct eligible cases.
  expect(await lookup(branch,{type:'shipment',externalId:'AMBIGUOUS'},baseline[branch])).toHaveLength(3);
 });
});
