import {describe,it,expect} from 'vitest';
import {deriveSourceCoverage,reconcileSourceAccounting,type SourceCoverageInput} from '../src/records/coverage.js';
import {evaluateReconstructionRules,type ReconstructionAssertion} from '../src/records/reconstruction-rules.js';

const now=new Date('2026-11-14T18:00:00Z');
const counts={received:1,acceptedLinked:1,acceptedUnlinked:0,duplicate:0,conflict:0,quarantined:0,rejected:0,processing:0};
const input=(connectionId:string,extra:Partial<SourceCoverageInput>={}):SourceCoverageInput=>({connectionId,sourceNamespace:connectionId,state:'active',lastReceivedAt:'2026-11-14T18:00:00Z',sourceAsOf:'2026-11-14T18:00:00Z',lastCheckedAt:'2026-11-14T18:00:00Z',expectedIntervalSeconds:3600,completeness:{kind:'snapshot',asOf:'2026-11-14T18:00:00Z',marker:'source-inventory-0042'},completenessPolicy:{kind:'snapshot',scope:'shipment_line',sourceOwnerQualified:true,qualificationReference:'synthetic-owner-contract/v1'},counts,...extra});
const health=(connectionId:string,extra:Partial<SourceCoverageInput>={})=>deriveSourceCoverage(input(connectionId,extra),now);
const assertion=(id:string,property:string,amount:string,extra:Partial<ReconstructionAssertion>={}):ReconstructionAssertion=>({id,subject:{namespace:'erp',type:'order_line',externalId:'0010482/004'},property,value:{amount,unit:'each'},unit:'each',active:true,comparisonScope:{line:'erp:order_line:0010482/004',shipment:'erp:shipment:S-0021',direction:'outbound'},source:{connectionId:id,receiptId:`batch-${id}`,observationId:`row-${id}`,sourceEventId:`event-${id}`,observationKind:'snapshot',row:12,field:property,locator:{row:12,field:property},mappingVersion:'synthetic/1',revision:'2',reportedAt:null,sourceAsOf:'2026-11-14T17:55:00Z',receivedAt:'2026-11-14T18:00:00Z',timeQuality:'snapshot_time_only',originalSha256:'a'.repeat(64),sourceNamespace:id,originSystem:null,copiedFromSource:null},...extra});

describe('qualified source coverage and exact receipt accounting',()=>{
 it('reconciles all mutually exclusive outcomes and exposes incomplete accounting',()=>{
  expect(reconcileSourceAccounting({...counts,received:7,acceptedLinked:1,acceptedUnlinked:1,duplicate:1,conflict:1,quarantined:1,rejected:1,processing:1}).reconciled).toBe(true);
  expect(deriveSourceCoverage(input('wms',{counts:{...counts,received:2}}),now)).toMatchObject({state:'coverage_unknown',accounting:{reconciled:false}});
 });
 it('does not let a received marker, configured cadence, or checked-empty source assert completeness',()=>{
  expect(health('wms',{completenessPolicy:null})).toMatchObject({state:'coverage_unknown',coverage:'unknown'});
  expect(health('wms',{completenessPolicy:{kind:'snapshot',scope:'shipment_line',sourceOwnerQualified:true}})).toMatchObject({state:'coverage_unknown',coverage:'unknown'});
  expect(health('wms',{completeness:{kind:'unknown',asOf:null,marker:null}})).toMatchObject({coverage:'unknown'});
 });
 it('separates a qualified quiet check from absence of warehouse activity',()=>{
  expect(health('wms',{lastReceivedAt:'2026-11-14T17:59:00Z'})).toMatchObject({state:'quiet_checked',coverage:'qualified'});
  expect(health('wms',{lastReceivedAt:'2026-11-14T17:59:00Z'}).nextAction).toContain('does not establish that no warehouse activity occurred');
 });
 it('makes drift and outages source-local and refuses future clock measurements',()=>{
  expect(health('wms',{errorCode:'MAPPING_DRIFT'})).toMatchObject({state:'mapping_drift'});
  expect(health('carrier',{errorCode:'SOURCE_UNREACHABLE'})).toMatchObject({state:'offline'});
  expect(health('orders')).toMatchObject({state:'current'});
  expect(health('future',{lastCheckedAt:'2026-11-15T00:00:00Z'})).toMatchObject({coverage:'unknown'});
 });
});

describe('source-linked shipment-line reconstruction comparisons',()=>{
 it('explains 10 allocated / 8 loaded / 8 received without inferring physical contents or fault',()=>{
  const values=[assertion('orders','allocatedQuantity','10'),assertion('wms','reportedLoadedQuantity','8'),assertion('delivery','reportedReceivedQuantity','8')];
  const result=evaluateReconstructionRules(values,values.map(value=>health(value.source.connectionId)));
  expect(result).toHaveLength(2);expect(result[0]).toMatchObject({outcome:'different',absoluteDifference:{numerator:'2',denominator:'1'},inputAssertionIds:['orders','wms'],physicalCondition:'not_established'});
  expect(result[0].explanation).toContain('10 each allocated');expect(result[0].inputs[1].source).toMatchObject({row:12,field:'reportedLoadedQuantity'});
  expect(result[1]).toMatchObject({outcome:'within_tolerance'});
  expect(JSON.stringify(result)).not.toMatch(/stolen|warehouse at fault|verified contents/);
 });
 it('uses shipment allocation rather than order total for split fulfillment',()=>{
  const values=[assertion('order-total','orderedQuantity','10'),assertion('allocation-a','allocatedQuantity','8'),assertion('loading-a','reportedLoadedQuantity','8'),assertion('allocation-b','allocatedQuantity','2',{comparisonScope:{line:'erp:order_line:0010482/004',shipment:'erp:shipment:S-0022',direction:'outbound'}}),assertion('loading-b','reportedLoadedQuantity','2',{comparisonScope:{line:'erp:order_line:0010482/004',shipment:'erp:shipment:S-0022',direction:'outbound'}})];
  const result=evaluateReconstructionRules(values,values.map(value=>health(value.source.connectionId)));
  expect(result.map(value=>value.outcome)).toEqual(['within_tolerance','within_tolerance']);
  expect(result.flatMap(value=>value.inputAssertionIds)).not.toContain('order-total');
 });
 it('counts only the explicitly active cumulative revision and retains exact decimal conversion',()=>{
  const values=[assertion('allocation','allocatedQuantity','1',{value:{amount:'1.000',unit:'kg'},unit:'kg'}),...Array.from({length:5},(_,i)=>assertion(`loading-${i}`,'reportedLoadedQuantity','1000',{value:{amount:'1000',unit:'g'},unit:'g',active:i===4}))];
  const result=evaluateReconstructionRules(values,values.map(value=>health(value.source.connectionId)));
  expect(result).toHaveLength(1);expect(result[0]).toMatchObject({outcome:'within_tolerance',absoluteDifference:{numerator:'0',denominator:'1'},inputAssertionIds:['allocation','loading-4']});
 });
 it('suppresses a delayed required source without concluding loss and labels unknown completeness',()=>{
  const values=[assertion('wms','reportedLoadedQuantity','10'),assertion('carrier','reportedReceivedQuantity','8')];
  expect(evaluateReconstructionRules(values,[health('wms'),health('carrier',{lastCheckedAt:'2026-11-14T16:00:00Z'})])[0]).toMatchObject({outcome:'suppressed'});
  expect(evaluateReconstructionRules(values,[health('wms'),health('carrier',{completenessPolicy:null})])[0]).toMatchObject({outcome:'not_comparable'});
 });
 it('does not guess unknown pack sizes, ambiguous snapshots, return direction, missing allocation or times',()=>{
  const allocated=assertion('orders','allocatedQuantity','10'),loaded=assertion('wms','reportedLoadedQuantity','1',{value:{amount:'1',unit:'case'},unit:'case'});
  expect(evaluateReconstructionRules([allocated,loaded],[health('orders'),health('wms')])[0].outcome).toBe('not_comparable');
  expect(evaluateReconstructionRules([allocated,assertion('wms','reportedLoadedQuantity','8'),assertion('wms-other','reportedLoadedQuantity','9')],[health('orders'),health('wms'),health('wms-other')])[0].outcome).toBe('not_comparable');
  expect(evaluateReconstructionRules([allocated,assertion('wms','reportedLoadedQuantity','8',{comparisonScope:{line:'erp:order_line:0010482/004',shipment:null,direction:'unknown'}})],[health('orders'),health('wms')])).toHaveLength(0);
  expect(evaluateReconstructionRules([allocated,{...assertion('wms','reportedLoadedQuantity','8'),source:{...loaded.source,sourceAsOf:null,timeQuality:'unknown'}}],[health('orders'),health('wms')])[0].outcome).toBe('not_comparable');
  expect(evaluateReconstructionRules([allocated,{...assertion('wms','reportedLoadedQuantity','8'),source:{...loaded.source,observationKind:'event'}}],[health('orders'),health('wms')])[0].outcome).toBe('not_comparable');
 });
 it('marks copied-source agreement as dependent and keeps comparison IDs stable on replay/reordering',()=>{
  const allocated=assertion('orders','allocatedQuantity','8'),loaded=assertion('wms','reportedLoadedQuantity','8');loaded.source.copiedFromSource='orders';
  const sources=[health('orders'),health('wms')],one=evaluateReconstructionRules([allocated,loaded],sources),two=evaluateReconstructionRules([loaded,allocated],sources);
  expect(one[0]).toMatchObject({outcome:'within_tolerance',independence:'copied'});expect(one[0].explanation).toContain('not independent corroboration');expect(one[0].id).toBe(two[0].id);
 });
 it('requires the source assertion to lie within its qualified boundary',()=>{
  const allocated=assertion('orders','allocatedQuantity','10'),loaded=assertion('wms','reportedLoadedQuantity','8');loaded.source.sourceAsOf='2026-11-14T19:00:00Z';
  expect(evaluateReconstructionRules([allocated,loaded],[health('orders'),health('wms')])[0]).toMatchObject({outcome:'not_comparable'});
 });
 it('withholds a shortage finding when a current cancellation or backorder changes the fulfillment question',()=>{
  const values=[assertion('orders','allocatedQuantity','10'),assertion('wms','reportedLoadedQuantity','8'),assertion('cancellation','canceledQuantity','2',{comparisonScope:{line:'erp:order_line:0010482/004',shipment:null,direction:'unknown'}})];
  expect(evaluateReconstructionRules(values,values.map(value=>health(value.source.connectionId)))[0]).toMatchObject({outcome:'not_comparable'});
 });
 it('compares explicit serialized units and never turns a serial list on a product line into a mismatch',()=>{
  const subject={namespace:'erp',type:'serialized_unit' as const,externalId:'reported-unit-004-01'};
  const a=assertion('orders','serial','0',{subject,value:'SERIAL-0001',unit:null}),b=assertion('delivery','serial','0',{subject,value:'SERIAL-0002',unit:null});
  expect(evaluateReconstructionRules([a,b],[health('orders'),health('delivery')])[0]).toMatchObject({outcome:'different',category:'serial_disagreement'});
  expect(evaluateReconstructionRules([{...a,subject:{namespace:'erp',type:'order_line',externalId:'004',parentExternalId:'0010482'}},{...b,subject:{namespace:'erp',type:'order_line',externalId:'004',parentExternalId:'0010482'}}],[health('orders'),health('delivery')])).toEqual([]);
 });
 it('keeps issue keys distinct across scoped cases reusing the same external identifiers',()=>{
  const values=[assertion('orders','allocatedQuantity','10'),assertion('wms','reportedLoadedQuantity','8')];
  const one=evaluateReconstructionRules(values.map(value=>({...value,comparisonScope:{...value.comparisonScope,caseId:'site-a-case'}})),[health('orders'),health('wms')]);
  const two=evaluateReconstructionRules(values.map(value=>({...value,comparisonScope:{...value.comparisonScope,caseId:'site-b-case'}})),[health('orders'),health('wms')]);
  expect(one[0].issueKey).not.toBe(two[0].issueKey);
 });
});
