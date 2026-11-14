import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {evaluateQuantities,type Quantity} from './quantities.js';
import type {TypedSourceReference,TypedSourceLocator} from './source-contracts.js';
import type {SourceCoverage} from './coverage.js';

export const RECONSTRUCTION_RULE_VERSION='packproof.reconstruction-comparison/v1' as const;
export interface ReconstructionAssertion {
 id:string;subject:TypedSourceReference;property:string;value:Quantity|string;unit:string|null;
 source:{subscriptionId?:string;connectionId:string;receiptId:string;observationId:string;sourceEventId:string;historyEligibility?:'within_bounds'|'unknown'|'out_of_bounds';observationKind:'event'|'snapshot'|'correction'|'tombstone';row:number;field:string;locator:TypedSourceLocator;mappingVersion:string;revision:string;reportedAt:string|null;sourceAsOf:string|null;receivedAt:string;timeQuality:string;originalSha256:string;sourceNamespace:string;originSystem:string|null;copiedFromSource:string|null};
 active:boolean;
 /** Deterministically resolved line and fulfillment identities, never SKU. */
 comparisonScope:{caseId?:string;line:string|null;shipment:string|null;direction:'outbound'|'return'|'unknown'};
}
export interface ReconstructionComparison {
 id:string;subject:TypedSourceReference;ruleVersion:typeof RECONSTRUCTION_RULE_VERSION;
 issueKey:string;category:'quantity_disagreement'|'serial_disagreement'|'source_coverage';
 outcome:'different'|'within_tolerance'|'not_comparable'|'suppressed';
 title:string;explanation:string;inputAssertionIds:string[];
 inputs:Array<Pick<ReconstructionAssertion,'id'|'property'|'value'|'source'>>;
 absoluteDifference:{numerator:string;denominator:string}|null;baseUnit:string|null;
 physicalCondition:'not_established';independence:'copied'|'unknown';
}

const PAIRS=[['allocatedQuantity','reportedLoadedQuantity','allocated','reported loaded'],['reportedLoadedQuantity','reportedReceivedQuantity','reported loaded','reported received']] as const;
const referenceKey=(r:TypedSourceReference)=>canonicalize([r.namespace,r.type,r.externalId,r.parentExternalId??null]);
const isQuantity=(value:Quantity|string):value is Quantity=>typeof value==='object'&&value!==null&&typeof value.amount==='string'&&typeof value.unit==='string';

/** Compares active assertions at their exact line/fulfillment grain. Cumulative
 * snapshots are selected by explicit supersession before this function; neither
 * repeated stages nor two competing sources are summed into invented totals. */
export function evaluateReconstructionRules(assertions:readonly ReconstructionAssertion[],sources:readonly SourceCoverage[]):ReconstructionComparison[] {
 const active=assertions.filter(value=>value.active);
 const groups=new Map<string,ReconstructionAssertion[]>();
 for(const assertion of active){
  if(!PAIRS.some(([left,right])=>assertion.property===left||assertion.property===right))continue;
  const s=assertion.comparisonScope;
  const key=canonicalize([s.caseId??null,s.line??referenceKey(assertion.subject),s.shipment,s.direction]);
  const list=groups.get(key)??[];list.push(assertion);groups.set(key,list);
 }
 const results:ReconstructionComparison[]=[];
 for(const [scope,values]of [...groups].sort(([a],[b])=>a.localeCompare(b))){
  for(const [left,right,leftLabel,rightLabel]of PAIRS){
   const expected=values.filter(value=>value.property===left),observed=values.filter(value=>value.property===right);
   if(!expected.length&&!observed.length)continue;
   // A later stage alone cannot establish a missing earlier warehouse action.
   if(!expected.length||!observed.length)continue;
   const inputs=[...expected,...observed].sort((a,b)=>a.id.localeCompare(b.id)),inputAssertionIds=inputs.map(value=>value.id),subject=inputs[0].subject;
   const id=`reconstruction_issue_${sha256Hex(canonicalize({scope,left,right,ruleVersion:RECONSTRUCTION_RULE_VERSION,inputAssertionIds}))}`;
   const issueKey=`case_issue_${sha256Hex(canonicalize({scope,left,right,ruleVersion:RECONSTRUCTION_RULE_VERSION}))}`;
   const common={id,issueKey,category:'quantity_disagreement',subject,ruleVersion:RECONSTRUCTION_RULE_VERSION,inputAssertionIds,inputs:inputs.map(({id,property,value,source})=>({id,property,value,source})),absoluteDifference:null,baseUnit:null,physicalCondition:'not_established',independence:inputs.some(value=>value.source.copiedFromSource!==null)?'copied':'unknown'} as const;
   const no=(explanation:string):ReconstructionComparison=>({...common,outcome:'not_comparable',title:'Reported quantities are not comparable',explanation});
   if(inputs.some(value=>!value.comparisonScope.line||!value.comparisonScope.shipment||value.comparisonScope.direction!=='outbound')){results.push(no('An explicit outbound shipment and stable line relationship is required. Order totals, returns, and ambiguous allocations are not substituted.'));continue;}
   if(expected.length!==1||observed.length!==1){results.push(no('Multiple active assertions exist for the same stage and shipment line. No source wins automatically and competing values are not summed.'));continue;}
   const modifiers=active.filter(value=>value.comparisonScope.line===inputs[0].comparisonScope.line&&(!value.comparisonScope.shipment||value.comparisonScope.shipment===inputs[0].comparisonScope.shipment)&&((['canceledQuantity','backorderedQuantity','reportedReturnedQuantity'].includes(value.property)&&isQuantity(value.value)&&!/^0(?:\.0+)?$/.test(value.value.amount))||(value.property==='status'&&typeof value.value==='string'&&/^(?:cancelled|canceled|backordered|backorder|substituted|replacement|returned)$/i.test(value.value))));
   if(modifiers.length){results.push(no('A cancellation, backorder, substitution, replacement or return is reported for this line. A qualified active fulfillment adjustment is required before a shortage comparison is meaningful.'));continue;}
   if(inputs.some(value=>!['snapshot','correction'].includes(value.source.observationKind)||value.source.timeQuality==='unknown'||value.source.sourceAsOf===null)){results.push(no('Comparable cumulative stage snapshots require explicit source-as-of times. Individual event quantities and unknown times are not treated as complete shipment totals.'));continue;}
   const sourceHealth=inputs.map(value=>sources.find(source=>source.connectionId===value.source.connectionId&&source.sourceNamespace===value.source.sourceNamespace&&(!value.source.subscriptionId||source.subscriptionId===value.source.subscriptionId)));
   if(sourceHealth.some(source=>!source||source.coverage!=='qualified')){results.push(no('The relevant source interval has not been qualified as complete. These reported values may be reviewed, but additional shipments or source changes cannot be ruled out.'));continue;}
   if(sourceHealth.some(source=>source!.state!=='current'&&source!.state!=='quiet_checked')){results.push({...common,outcome:'suppressed',title:'Comparison waiting for current source data',explanation:'A required source is delayed, paused, unresolved, or unavailable. Missing updates do not establish missing goods.'});continue;}
   if(inputs.some((value,index)=>Date.parse(value.source.sourceAsOf!)>Date.parse(sourceHealth[index]!.completeness.asOf!))){results.push(no('A source assertion falls beyond its qualified completeness boundary. Reconcile that interval before comparing stage totals.'));continue;}
   const e=expected[0].value,o=observed[0].value;
   if(!isQuantity(e)||!isQuantity(o)){results.push(no('Both stage assertions must contain an explicit decimal quantity and a compatible unit.'));continue;}
   const evaluation=evaluateQuantities(e,[o]);
   if(evaluation.outcome==='not_comparable'){results.push(no(evaluation.reason));continue;}
   const difference=evaluation.absoluteDifference!;
   const differenceLabel=difference.denominator==='1'?difference.numerator:`${difference.numerator}/${difference.denominator}`;
   results.push({...common,outcome:evaluation.outcome,absoluteDifference:difference,baseUnit:evaluation.baseUnit,
    title:evaluation.outcome==='different'?`${differenceLabel} ${evaluation.baseUnit} difference between ${leftLabel} and ${rightLabel} quantities`:`${leftLabel[0].toUpperCase()+leftLabel.slice(1)} and ${rightLabel} quantities agree`,
    explanation:`The active shipment-line assertions report ${e.amount} ${e.unit} ${leftLabel} and ${o.amount} ${o.unit} ${rightLabel}. ${evaluation.outcome==='different'?`The exact difference is ${differenceLabel} ${evaluation.baseUnit}.`:'The exact quantities are within the declared zero tolerance.'} These are source-reported quantities; physical contents and responsibility are not established.${common.independence==='copied'?' One source declares copied information, so agreement is not independent corroboration.':' Source independence has not been established.'}`});
  }
 }
 // Serial values are comparable only for an explicitly identified same unit.
 // A line with several units or two matching SKUs never establishes that key.
 const serials=new Map<string,ReconstructionAssertion[]>();
 for(const value of active.filter(value=>value.property==='serial'&&value.subject.type==='serialized_unit')){const key=canonicalize([value.comparisonScope.caseId??null,referenceKey(value.subject),value.comparisonScope.shipment,value.comparisonScope.direction]),list=serials.get(key)??[];list.push(value);serials.set(key,list);}
 for(const [scope,values]of [...serials].sort(([a],[b])=>a.localeCompare(b))){
  if(values.length<2)continue;
  const inputs=[...values].sort((a,b)=>a.id.localeCompare(b.id)),inputAssertionIds=inputs.map(value=>value.id),issueKey=`case_issue_${sha256Hex(canonicalize({scope,rule:'serial',ruleVersion:RECONSTRUCTION_RULE_VERSION}))}`;
  const common={id:`reconstruction_issue_${sha256Hex(canonicalize({issueKey,inputAssertionIds}))}`,issueKey,category:'serial_disagreement',subject:inputs[0].subject,ruleVersion:RECONSTRUCTION_RULE_VERSION,inputAssertionIds,inputs:inputs.map(({id,property,value,source})=>({id,property,value,source})),absoluteDifference:null,baseUnit:null,physicalCondition:'not_established',independence:inputs.some(value=>value.source.copiedFromSource!==null)?'copied':'unknown'} as const;
  const sourceHealth=inputs.map(value=>sources.find(source=>source.connectionId===value.source.connectionId&&source.sourceNamespace===value.source.sourceNamespace&&(!value.source.subscriptionId||source.subscriptionId===value.source.subscriptionId)));
  if(inputs.some(value=>typeof value.value!=='string'||!value.value||!value.comparisonScope.shipment)||new Set(inputs.map(value=>value.source.subscriptionId??value.source.connectionId)).size!==inputs.length||sourceHealth.some(source=>!source||source.coverage!=='qualified')){results.push({...common,outcome:'not_comparable',title:'Serial assertions need qualified unit context',explanation:'Serial disagreement requires the same explicit serialized unit, one active assertion per source, and qualified source intervals. Missing serials and repeated line/SKU values are not mismatches.'});continue;}
  if(sourceHealth.some(source=>!['current','quiet_checked'].includes(source!.state))){results.push({...common,outcome:'suppressed',title:'Serial comparison waiting for source data',explanation:'A relevant source is delayed or unavailable. Physical contents and responsibility are not established.'});continue;}
  const same=new Set(inputs.map(value=>value.value)).size===1;
  results.push({...common,outcome:same?'within_tolerance':'different',title:same?'Source-reported serials agree':'Source-reported serials disagree',explanation:same?'The qualified sources report the same serial for this explicitly related unit. Physical contents and source independence are not established.':'The qualified sources report different serial values for the same explicitly related unit. Open both source rows to review the disagreement; responsibility is not established.'});
 }
 return results;
}
