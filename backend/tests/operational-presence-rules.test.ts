import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {parseTypedSourceBatch} from '../src/records/source-contracts.js';
import {deriveSourceCoverage,type SourceCoverage,type SourceCompletenessScope} from '../src/records/coverage.js';
import {evaluateReconstructionRules,type ReconstructionAssertion} from '../src/records/reconstruction-rules.js';
import {parseSourceRulePolicies,referencedRuleSources,type RuleSourceBinding,type SourceRulePolicies} from '../src/records/source-rule-policy.js';

const now=new Date('2026-11-14T18:00:00Z');
const binding=(name:string):RuleSourceBinding=>({subscriptionId:`sub_${name}`,configurationRevision:1,sourceNamespace:`source_${name}`});
const label=binding('labels'),carrier=binding('carrier'),expected=binding('expected'),loading=binding('loading'),receipt=binding('receipt');
const counts={received:1,acceptedLinked:1,acceptedUnlinked:0,duplicate:0,conflict:0,quarantined:0,rejected:0,processing:0};
function health(source:RuleSourceBinding,scope:SourceCompletenessScope,extra:Partial<SourceCoverage>={}):SourceCoverage {
 return {...deriveSourceCoverage({connectionId:`account_${source.subscriptionId}`,sourceNamespace:source.sourceNamespace,state:'active',lastReceivedAt:now.toISOString(),sourceAsOf:now.toISOString(),lastCheckedAt:now.toISOString(),expectedIntervalSeconds:3600,completeness:{kind:'snapshot',asOf:now.toISOString(),marker:'owner-qualified-inventory-001'},completenessPolicy:{kind:'snapshot',scope,sourceOwnerQualified:true,qualificationReference:'Synthetic source-owner test contract'},counts},now),subscriptionId:source.subscriptionId,configurationRevision:source.configurationRevision,...extra};
}
const labelPolicy:SourceRulePolicies={schema:'packproof.source-rule-policies/v1',version:'fixture/1',sourceOwnerQualified:true,qualificationReference:'Synthetic declared carrier contract',labelAcceptance:{labelSource:label,acceptanceSource:carrier,subjectNamespace:'qualified-package-namespace',carrier:{code:'carrier-fixture',accountReference:'account-004',service:'ground'},windowSeconds:3600,graceSeconds:60,labelCreatedValues:['LABEL_CREATED'],labelVoidedValues:['VOIDED'],acceptedValues:['PACKAGE_ACCEPTED']}};
const handoffPolicy:SourceRulePolicies={schema:'packproof.source-rule-policies/v1',version:'fixture/1',sourceOwnerQualified:true,qualificationReference:'Synthetic declared unit inventory contract',handlingUnitHandoff:{expectationSource:expected,loadingSource:loading,receiptSource:receipt,subjectNamespace:'qualified-unit-namespace',scope:'case_shipment_stop',dueAtProperty:'expectedHandoffAt',windowSeconds:3600,graceSeconds:60,expectedValues:['EXPECTED'],loadedValues:['UNIT_LOADED'],receivedValues:['UNIT_RECEIVED']}};
function fact(source:RuleSourceBinding,id:string,property:string,value:string,kind:'tracking'|'handling_unit'='tracking',externalId='000045'):ReconstructionAssertion {
 return {id,subject:{namespace:kind==='tracking'?'qualified-package-namespace':'qualified-unit-namespace',type:kind,externalId},property,value,unit:null,active:true,comparisonScope:{caseId:'case_a',line:null,shipment:'shipment-S-0021',direction:'outbound',...(kind==='handling_unit'?{load:'load-00071',stop:'stop-STOP-9'}:{})},source:{subscriptionId:source.subscriptionId,connectionId:`account_${source.subscriptionId}`,sourceNamespace:source.sourceNamespace,receiptId:`batch-${source.subscriptionId}`,observationId:`row-${id}`,sourceEventId:`event-${id}`,observationKind:'event',row:12,field:property,locator:{row:12,field:property},mappingVersion:'fixture/1',revision:'1',reportedAt:'2026-11-14T16:00:00Z',sourceAsOf:null,receivedAt:'2026-11-14T17:59:00Z',timeQuality:'event_time',originalSha256:'a'.repeat(64),originSystem:null,copiedFromSource:null}};
}
function carrierContext(source:RuleSourceBinding){return [['carrierCode','carrier-fixture'],['carrierAccountReference','account-004'],['carrierService','ground']].map(([property,value])=>fact(source,`${source.subscriptionId}-${property}`,property,value));}
const labelFacts=()=>[fact(label,'created','labelStatus','LABEL_CREATED'),...carrierContext(label)];
const labelHealth=()=>[health(label,'tracking_package'),health(carrier,'tracking_package')];
function run(values:ReconstructionAssertion[],sources:SourceCoverage[]=labelHealth(),policy=labelPolicy,at:Date=now){return evaluateReconstructionRules(values,sources,{now:at,policies:[policy]}).filter(value=>['label_acceptance_gap','handling_unit_handoff_gap'].includes(value.category));}

describe('versioned source-specific operational rule policies',()=>{
 it('keeps absent policies off and binds exact source revisions/namespaces without defaults',()=>{
  expect(parseSourceRulePolicies(null)).toBeNull();expect(parseSourceRulePolicies(labelPolicy)).toEqual(labelPolicy);
  expect(referencedRuleSources(labelPolicy)).toEqual([carrier,label]);
  expect(evaluateReconstructionRules(labelFacts(),labelHealth())).toEqual([]);
  for(const extra of [{qualificationReference:null},{version:''},{unrecognized:true}])expect(()=>parseSourceRulePolicies({...labelPolicy,...extra})).toThrow();
 });
 it('rejects incompatible status meaning, unsupported time basis and contradictory source bindings',()=>{
  expect(()=>parseSourceRulePolicies({...labelPolicy,labelAcceptance:{...labelPolicy.labelAcceptance,labelVoidedValues:['LABEL_CREATED']}})).toThrow(/both created and voided/);
  expect(()=>parseSourceRulePolicies({...labelPolicy,labelAcceptance:{...labelPolicy.labelAcceptance,windowSeconds:-1}})).toThrow();
  expect(()=>parseSourceRulePolicies({...handoffPolicy,handlingUnitHandoff:{...handoffPolicy.handlingUnitHandoff,dueAtProperty:'receivedAt'}})).toThrow();
  expect(()=>parseSourceRulePolicies({...labelPolicy,labelAcceptance:{...labelPolicy.labelAcceptance,acceptanceSource:{...label,configurationRevision:2}}})).toThrow(/contradictory/);
 });
});

describe('qualified label to carrier acceptance observations',()=>{
 it('reports absent acceptance only after the real creation window and qualified source boundary',()=>{
  const finding=run(labelFacts())[0];expect(finding).toMatchObject({category:'label_acceptance_gap',outcome:'different',deadlineAt:'2026-11-14T17:01:00.000Z',policyVersion:'fixture/1',physicalCondition:'not_established'});
  expect(finding.explanation).toContain('gap in connected reports');expect(finding.inputAssertionIds).toContain('created');
  expect(finding.explanation).not.toMatch(/carrier lost|warehouse at fault|stolen|verified contents/);
 });
 it('requires explicit source-owner qualification rather than a configured badge or status string',()=>{
  expect(run(labelFacts(),labelHealth(),{...labelPolicy,sourceOwnerQualified:false,qualificationReference:null})[0]).toMatchObject({outcome:'not_comparable'});
  expect(run(labelFacts(),[health(label,'shipment_line'),health(carrier,'tracking_package')])[0]).toMatchObject({outcome:'not_comparable'});
  expect(run(labelFacts(),labelHealth().slice(0,1))[0]).toMatchObject({outcome:'not_comparable'});
 });
 it('suppresses source outages and changed config, and never turns a recent upload into complete inventory',()=>{
  expect(run(labelFacts(),[health(label,'tracking_package'),health(carrier,'tracking_package',{state:'offline'})])[0]).toMatchObject({outcome:'suppressed'});
  expect(run(labelFacts(),[health(label,'tracking_package'),health(carrier,'tracking_package',{configurationRevision:2})])[0]).toMatchObject({outcome:'suppressed'});
  expect(run(labelFacts(),[health(label,'tracking_package'),health(carrier,'tracking_package',{coverage:'unknown'})])[0]).toMatchObject({outcome:'not_comparable'});
  const incomplete=health(carrier,'tracking_package');incomplete.completeness={...incomplete.completeness,asOf:'2026-11-14T16:30:00Z'};
  expect(run(labelFacts(),[health(label,'tracking_package'),incomplete])[0]).toMatchObject({outcome:'suppressed'});
 });
 it('does not use snapshot, receipt, unknown or future timestamps as label creation time',()=>{
  for(const source of [{observationKind:'snapshot',reportedAt:null,sourceAsOf:'2026-11-14T16:00:00Z',timeQuality:'snapshot_time_only'},{reportedAt:null,timeQuality:'unknown'},{reportedAt:'2026-11-15T00:00:00Z'}] as const){const values=labelFacts();values[0]={...values[0],source:{...values[0].source,...source}};expect(run(values)[0].outcome).toBe('not_comparable');}
 });
 it('suppresses before the deadline and treats an exact deadline consistently',()=>{
  const values=labelFacts();values[0].source.reportedAt='2026-11-14T17:00:00Z';
  expect(run(values)[0].outcome).toBe('suppressed');
  expect(run(values,labelHealth(),labelPolicy,new Date('2026-11-14T18:01:00Z'))[0].outcome).toBe('suppressed');
  const sources=labelHealth().map(s=>({...s,completeness:{...s.completeness,asOf:'2026-11-14T18:01:00Z'}}));
  expect(run(values,sources,labelPolicy,new Date('2026-11-14T18:01:00Z'))[0].outcome).toBe('different');
 });
 it('does not require acceptance for a current explicitly voided label',()=>{
  const values=labelFacts();values[0].value='VOIDED';expect(run(values)[0]).toMatchObject({outcome:'within_tolerance',title:'Source reports the label voided'});values[0].source.reportedAt=null;expect(run(values)[0].outcome).toBe('not_comparable');
 });
 it('requires exact carrier account/service metadata and package/shipment identity',()=>{
  const values=labelFacts();values.find(value=>value.property==='carrierAccountReference')!.value='another-account';expect(run(values)[0].outcome).toBe('not_comparable');
  const other=fact(carrier,'other-package','carrierAcceptanceStatus','PACKAGE_ACCEPTED','tracking','000046');
  expect(run([...labelFacts(),other,...carrierContext(carrier)])[0].outcome).toBe('different');
  const accepted=fact(carrier,'other-shipment','carrierAcceptanceStatus','PACKAGE_ACCEPTED');accepted.comparisonScope.shipment='shipment-S-0022';
  expect(run([...labelFacts(),accepted,...carrierContext(carrier)])[0].outcome).toBe('different');
 });
 it('resolves from an actual exact acceptance event, records late timing and retains stable replay identity',()=>{
  const accepted=fact(carrier,'accepted','carrierAcceptanceStatus','PACKAGE_ACCEPTED');accepted.source.reportedAt='2026-11-14T17:30:00Z';
  const facts=[...labelFacts(),accepted,...carrierContext(carrier)],first=run(facts)[0],second=run([...facts].reverse())[0];
  expect(first).toMatchObject({outcome:'within_tolerance',issueKey:run(labelFacts())[0].issueKey});expect(first.explanation).toContain('after the approved window');expect(first.id).toBe(second.id);
  accepted.source.copiedFromSource=label.subscriptionId;expect(run(facts)[0]).toMatchObject({outcome:'not_comparable',independence:'copied'});
 });
 it('evaluates a real approved composite CSV event without treating snapshot or tracking fields as acceptance',()=>{
  const corpus=JSON.parse(readFileSync(new URL('./fixtures/reconstruction/source-contract-corpus-v2.json',import.meta.url),'utf8')),fixture=corpus.cases.find((value:{name:string})=>value.name==='composite-label-immutable-event'),parsed=parseTypedSourceBatch(fixture.input),row=parsed.rows[0];expect(row.errors).toEqual([]);
  const original=row.normalized!,assertion=original.assertions[0],created=fact(label,'actual-csv-label',assertion.property,String(assertion.value));created.subject=assertion.subjectReference;created.source={...created.source,sourceEventId:original.sourceEventId,revision:original.sourceRevision,reportedAt:original.occurredAt,observationKind:original.observationKind,timeQuality:original.timeQuality};
  const p={...labelPolicy,labelAcceptance:{...labelPolicy.labelAcceptance!,subjectNamespace:created.subject.namespace,labelCreatedValues:['created']}},context=carrierContext(label).map(value=>({...value,subject:created.subject}));expect(run([created,...context],labelHealth(),p)[0].outcome).toBe('different');
  const unknownCase=labelFacts().map(value=>({...value,comparisonScope:{...value.comparisonScope,caseId:undefined}}));expect(run(unknownCase)[0].outcome).toBe('not_comparable');
 });
 it('withholds a conclusion for competing statuses, missing accepted event time and cancellation/returns',()=>{
  const accepted=fact(carrier,'accepted','carrierAcceptanceStatus','PACKAGE_ACCEPTED');accepted.source.reportedAt=null;
  expect(run([...labelFacts(),accepted,...carrierContext(carrier)])[0].outcome).toBe('not_comparable');
  const canceled=fact(label,'canceled','status','canceled');expect(run([...labelFacts(),canceled])[0].outcome).toBe('not_comparable');
  const returned=labelFacts().map(value=>({...value,comparisonScope:{...value.comparisonScope,direction:'return' as const}}));expect(run(returned)[0].outcome).toBe('not_comparable');
  const two=[...labelFacts(),fact(label,'created-second','labelStatus','LABEL_CREATED')];expect(run(two)[0].outcome).toBe('not_comparable');
 });
});

function unitFacts(ids=['UNIT-A','UNIT-B','UNIT-C']) {
 return ids.flatMap(id=>[fact(expected,`${id}-expected`,'expectedHandoffStatus','EXPECTED','handling_unit',id),fact(expected,`${id}-due`,'expectedHandoffAt','2026-11-14T16:00:00Z','handling_unit',id)]);
}
const unitHealth=()=>[health(expected,'handling_unit_set'),health(loading,'handling_unit_set'),health(receipt,'handling_unit_set')];
const unitRun=(values:ReconstructionAssertion[],sources=unitHealth())=>run(values,sources,handoffPolicy)[0];
describe('qualified handling-unit loading and receipt inventory gaps',()=>{
 it('distinguishes absent loading reports from absent receipts at the exact unit grain',()=>{
  const values=[...unitFacts(),fact(loading,'A-loaded','loadingHandoffStatus','UNIT_LOADED','handling_unit','UNIT-A'),fact(loading,'B-loaded','loadingHandoffStatus','UNIT_LOADED','handling_unit','UNIT-B'),fact(receipt,'A-received','receiptHandoffStatus','UNIT_RECEIVED','handling_unit','UNIT-A')];
  const finding=unitRun(values);expect(finding).toMatchObject({outcome:'different',category:'handling_unit_handoff_gap',deadlineAt:'2026-11-14T17:01:00.000Z'});expect(finding.explanation).toContain('1 expected handling unit(s) have no loading report');expect(finding.explanation).toContain('1 reported-loaded unit(s) have no receipt report');expect(finding.inputAssertionIds).toContain('UNIT-C-expected');
 });
 it('reports accounted unit IDs without claiming contents, custody or independent observations',()=>{
  const values=[...unitFacts(['UNIT-A']),fact(loading,'A-loaded','loadingHandoffStatus','UNIT_LOADED','handling_unit','UNIT-A'),fact(receipt,'A-received','receiptHandoffStatus','UNIT_RECEIVED','handling_unit','UNIT-A')];
  expect(unitRun(values)).toMatchObject({outcome:'within_tolerance',physicalCondition:'not_established',independence:'unknown'});
 });
 it('does not infer a package handoff from an aggregate trailer event or another stop',()=>{
  const aggregate=fact(loading,'trailer','loadingHandoffStatus','UNIT_LOADED','handling_unit','TRAILER');aggregate.subject.type='load';
  expect(unitRun([...unitFacts(['UNIT-A']),aggregate]).explanation).toContain('1 expected handling unit(s) have no loading report');
  const anotherStop=fact(receipt,'A-other-stop','receiptHandoffStatus','UNIT_RECEIVED','handling_unit','UNIT-A');anotherStop.comparisonScope.stop='stop-another';
  const loaded=fact(loading,'A-loaded','loadingHandoffStatus','UNIT_LOADED','handling_unit','UNIT-A');
  expect(unitRun([...unitFacts(['UNIT-A']),loaded,anotherStop]).explanation).toContain('1 reported-loaded unit(s) have no receipt report');
 });
 it('compares extra loaded units and refuses reversed event order or stale expected inventory',()=>{
  const loaded=fact(loading,'A-loaded','loadingHandoffStatus','UNIT_LOADED','handling_unit','UNIT-A'),received=fact(receipt,'A-received','receiptHandoffStatus','UNIT_RECEIVED','handling_unit','UNIT-A'),unexpected=fact(loading,'B-loaded','loadingHandoffStatus','UNIT_LOADED','handling_unit','UNIT-B');
  expect(unitRun([...unitFacts(['UNIT-A']),loaded,received,unexpected]).explanation).toContain('1 loaded unit(s) and 0 received unit(s) are outside');
  loaded.source.reportedAt='2026-11-14T17:00:00Z';expect(unitRun([...unitFacts(['UNIT-A']),loaded,received]).outcome).toBe('not_comparable');
  const sources=unitHealth();sources[0].completeness={...sources[0].completeness,asOf:'2026-11-14T16:30:00Z'};expect(unitRun(unitFacts(['UNIT-A']),sources).outcome).toBe('suppressed');
 });
 it('requires an explicit planned deadline and never substitutes source-as-of or receipt time',()=>{
  expect(unitRun(unitFacts(['UNIT-A']).filter(value=>value.property!=='expectedHandoffAt')).outcome).toBe('not_comparable');
  const values=unitFacts(['UNIT-A']);values[1].value='not-a-time';expect(unitRun(values).outcome).toBe('not_comparable');
 });
 it('withholds a finding before planned grace and during source outage or incomplete boundary',()=>{
  const values=unitFacts(['UNIT-A']);values[1].value='2026-11-14T18:30:00Z';expect(unitRun(values).outcome).toBe('suppressed');
  expect(unitRun(unitFacts(['UNIT-A']),unitHealth().map(source=>source.subscriptionId===receipt.subscriptionId?{...source,state:'offline'}:source)).outcome).toBe('suppressed');
  const sources=unitHealth();sources[1].completeness={...sources[1].completeness,asOf:'2026-11-14T16:59:00Z'};expect(unitRun(unitFacts(['UNIT-A']),sources).outcome).toBe('suppressed');
 });
 it('preserves case and shipment scope and refuses duplicate expected identities or unmapped statuses',()=>{
  const values=unitFacts(['UNIT-A']);values[0].value='UNKNOWN_STATUS';expect(unitRun(values).outcome).toBe('not_comparable');
  const duplicate=[...unitFacts(['UNIT-A']),fact(expected,'duplicate-A','expectedHandoffStatus','EXPECTED','handling_unit','UNIT-A')];expect(unitRun(duplicate).outcome).toBe('not_comparable');
  const unknown=unitFacts(['UNIT-A']);unknown[0].comparisonScope.stop=null;expect(unitRun(unknown).outcome).toBe('not_comparable');
 });
 it('uses approved normalized unit identities across source namespaces and keeps keys distinct across cases',()=>{
  const values=[...unitFacts(['UNIT-A']),fact(loading,'A-loaded','loadingHandoffStatus','UNIT_LOADED','handling_unit','LOCAL-A'),fact(receipt,'A-received','receiptHandoffStatus','UNIT_RECEIVED','handling_unit','OTHER-A')].map(value=>({...value,comparisonScope:{...value.comparisonScope,handlingUnit:'qualified-unit-key'}}));
  expect(unitRun(values).outcome).toBe('within_tolerance');
  const one=unitRun(unitFacts(['UNIT-A'])),two=unitRun(unitFacts(['UNIT-A']).map(value=>({...value,comparisonScope:{...value.comparisonScope,caseId:'case_b'}})));expect(one.issueKey).not.toBe(two.issueKey);
 });
});
