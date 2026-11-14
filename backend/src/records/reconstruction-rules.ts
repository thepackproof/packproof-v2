import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {evaluateQuantities,type Quantity} from './quantities.js';
import type {TypedSourceReference,TypedSourceLocator,TypedSourceObservation} from './source-contracts.js';
import type {SourceCoverage} from './coverage.js';
import type {SourceRulePolicies,RuleSourceBinding,LabelAcceptancePolicy,HandlingUnitHandoffPolicy} from './source-rule-policy.js';
import {explicitInstant} from './csv-semantics.js';

export const RECONSTRUCTION_RULE_VERSION='packproof.reconstruction-comparison/v1' as const;
export const OPERATIONAL_PRESENCE_RULE_VERSION='packproof.operational-presence/v1' as const;
export interface ReconstructionAssertion {
 id:string;subject:TypedSourceReference;property:string;value:Quantity|string;unit:string|null;
 source:{subscriptionId?:string;connectionId:string;receiptId:string;observationId:string;sourceEventId:string;historyEligibility?:'within_bounds'|'unknown'|'out_of_bounds';observationKind:'event'|'snapshot'|'correction'|'tombstone';row:number;field:string;locator:TypedSourceLocator;mappingVersion:string;revision:string;reportedAt:string|null;sourceAsOf:string|null;receivedAt:string;timeQuality:string;originalSha256:string;sourceNamespace:string;originSystem:string|null;copiedFromSource:string|null;identityDerivation?:TypedSourceObservation['identityDerivation'];identityBasis?:ReconstructionIdentityBasis[];comparisonIdentity?:{subject:TypedSourceReference;fields:Array<{reference:TypedSourceReference;canonicalReference:TypedSourceReference;basis:ReconstructionIdentityBasis[]}>}};
 active:boolean;
 /** Deterministically resolved line and fulfillment identities, never SKU. */
 comparisonScope:{caseId?:string;line:string|null;shipment:string|null;direction:'outbound'|'return'|'unknown';tracking?:string|null;handlingUnit?:string|null;load?:string|null;stop?:string|null;serializedUnit?:string|null;subjectNamespace?:string};
}
interface ReconstructionIdentityBasis {id:string;revisionHash:string;ruleVersion:string;reason:string;approvedBy:string;approvedAt:string;effectiveFrom:string|null;effectiveUntil:string|null;}
export interface ReconstructionComparison {
 id:string;subject:TypedSourceReference;ruleVersion:typeof RECONSTRUCTION_RULE_VERSION|typeof OPERATIONAL_PRESENCE_RULE_VERSION;
 issueKey:string;category:'quantity_disagreement'|'serial_disagreement'|'source_coverage'|'label_acceptance_gap'|'handling_unit_handoff_gap';
 outcome:'different'|'within_tolerance'|'not_comparable'|'suppressed';
 title:string;explanation:string;inputAssertionIds:string[];
 inputs:Array<Pick<ReconstructionAssertion,'id'|'property'|'value'|'source'>>;
 absoluteDifference:{numerator:string;denominator:string}|null;baseUnit:string|null;
 physicalCondition:'not_established';independence:'copied'|'unknown';
 policyVersion?:string;deadlineAt?:string|null;
}
export interface ReconstructionRuleContext {now:Date|string;policies?:readonly SourceRulePolicies[];}

const PAIRS=[['allocatedQuantity','reportedLoadedQuantity','allocated','reported loaded'],['reportedLoadedQuantity','reportedReceivedQuantity','reported loaded','reported received']] as const;
const referenceKey=(r:TypedSourceReference)=>canonicalize([r.namespace,r.type,r.externalId,r.parentExternalId??null]);
const isQuantity=(value:Quantity|string):value is Quantity=>typeof value==='object'&&value!==null&&typeof value.amount==='string'&&typeof value.unit==='string';

/** Compares active assertions at their exact line/fulfillment grain. Cumulative
 * snapshots are selected by explicit supersession before this function; neither
 * repeated stages nor two competing sources are summed into invented totals. */
export function evaluateReconstructionRules(assertions:readonly ReconstructionAssertion[],sources:readonly SourceCoverage[],context?:ReconstructionRuleContext):ReconstructionComparison[] {
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
   if(sourceHealth.some(source=>!source||source.coverage!=='qualified'||source.completeness.scope!=='shipment_line')){results.push(no('The relevant shipment-line source interval has not been qualified as complete. These reported values may be reviewed, but additional shipments or source changes cannot be ruled out.'));continue;}
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
 for(const value of active.filter(value=>value.property==='serial'&&value.subject.type==='serialized_unit')){const key=canonicalize([value.comparisonScope.caseId??null,value.comparisonScope.serializedUnit??referenceKey(value.subject),value.comparisonScope.shipment,value.comparisonScope.direction]),list=serials.get(key)??[];list.push(value);serials.set(key,list);}
 for(const [scope,values]of [...serials].sort(([a],[b])=>a.localeCompare(b))){
  if(values.length<2)continue;
  const inputs=[...values].sort((a,b)=>a.id.localeCompare(b.id)),inputAssertionIds=inputs.map(value=>value.id),issueKey=`case_issue_${sha256Hex(canonicalize({scope,rule:'serial',ruleVersion:RECONSTRUCTION_RULE_VERSION}))}`;
  const common={id:`reconstruction_issue_${sha256Hex(canonicalize({issueKey,inputAssertionIds}))}`,issueKey,category:'serial_disagreement',subject:inputs[0].subject,ruleVersion:RECONSTRUCTION_RULE_VERSION,inputAssertionIds,inputs:inputs.map(({id,property,value,source})=>({id,property,value,source})),absoluteDifference:null,baseUnit:null,physicalCondition:'not_established',independence:inputs.some(value=>value.source.copiedFromSource!==null)?'copied':'unknown'} as const;
  const sourceHealth=inputs.map(value=>sources.find(source=>source.connectionId===value.source.connectionId&&source.sourceNamespace===value.source.sourceNamespace&&(!value.source.subscriptionId||source.subscriptionId===value.source.subscriptionId)));
  if(inputs.some(value=>typeof value.value!=='string'||!value.value||!value.comparisonScope.shipment)||new Set(inputs.map(value=>value.source.subscriptionId??value.source.connectionId)).size!==inputs.length||sourceHealth.some(source=>!source||source.coverage!=='qualified'||source.completeness.scope!=='shipment_line')){results.push({...common,outcome:'not_comparable',title:'Serial assertions need qualified unit context',explanation:'Serial disagreement requires the same explicit serialized unit, one active assertion per source, and qualified shipment-line source intervals. Missing serials and repeated line/SKU values are not mismatches.'});continue;}
  if(sourceHealth.some(source=>!['current','quiet_checked'].includes(source!.state))){results.push({...common,outcome:'suppressed',title:'Serial comparison waiting for source data',explanation:'A relevant source is delayed or unavailable. Physical contents and responsibility are not established.'});continue;}
  const same=new Set(inputs.map(value=>value.value)).size===1;
  results.push({...common,outcome:same?'within_tolerance':'different',title:same?'Source-reported serials agree':'Source-reported serials disagree',explanation:same?'The qualified sources report the same serial for this explicitly related unit. Physical contents and source independence are not established.':'The qualified sources report different serial values for the same explicitly related unit. Open both source rows to review the disagreement; responsibility is not established.'});
 }
 if(context)results.push(...evaluateOperationalPresenceRules(assertions,sources,context));
 return results;
}

type PresenceOutcome=ReconstructionComparison['outcome'];
type PresenceCategory='label_acceptance_gap'|'handling_unit_handoff_gap';
type SourceReadiness={outcome:'not_comparable'|'suppressed';reason:string}|null;
const usable=(source:SourceCoverage)=>source.state==='current'||source.state==='quiet_checked';
const sameSource=(assertion:ReconstructionAssertion,binding:RuleSourceBinding)=>assertion.source.subscriptionId===binding.subscriptionId&&assertion.source.sourceNamespace===binding.sourceNamespace;
const operationalNamespace=(assertion:ReconstructionAssertion)=>assertion.comparisonScope.subjectNamespace??assertion.subject.namespace;
const subjectIdentity=(assertion:ReconstructionAssertion)=>assertion.subject.type==='tracking'?(assertion.comparisonScope.tracking??referenceKey(assertion.subject)):assertion.subject.type==='handling_unit'?(assertion.comparisonScope.handlingUnit??referenceKey(assertion.subject)):referenceKey(assertion.subject);
const sameCaseShipment=(a:ReconstructionAssertion,b:ReconstructionAssertion)=>a.comparisonScope.caseId===b.comparisonScope.caseId&&a.comparisonScope.shipment===b.comparisonScope.shipment;
const eventInstant=(a:ReconstructionAssertion)=>a.source.observationKind==='event'&&a.source.timeQuality==='event_time'&&a.source.reportedAt!==null?explicitInstant(a.source.reportedAt):null;
function sourceReadiness(sources:readonly SourceCoverage[],binding:RuleSourceBinding,scope:'tracking_package'|'handling_unit_set',deadline:number|null=null):SourceReadiness {
 const source=sources.find(s=>s.subscriptionId===binding.subscriptionId&&s.sourceNamespace===binding.sourceNamespace);
 if(!source)return {outcome:'not_comparable',reason:'A required approved source is not available in this case scope. No missing physical action is inferred.'};
 if(source.configurationRevision!==binding.configurationRevision)return {outcome:'suppressed',reason:'A required source configuration changed. An administrator must reapprove the exact rule/source binding before absence reasoning resumes.'};
 if(!usable(source))return {outcome:'suppressed',reason:'A required source is delayed, paused, unresolved or unavailable. Missing updates do not establish missing goods.'};
 if(source.coverage!=='qualified'||source.completeness.scope!==scope||!source.completeness.marker||!source.completeness.asOf)return {outcome:'not_comparable',reason:`The relevant ${scope==='tracking_package'?'package tracking':'handling-unit inventory'} interval has not been qualified as complete. Absence cannot be established from the last report alone.`};
 if(deadline!==null&&(explicitInstant(source.completeness.asOf)===null||Date.parse(source.completeness.asOf)<deadline))return {outcome:'suppressed',reason:'The qualified source inventory has not advanced beyond the approved deadline. Reconcile that interval before interpreting an absent report.'};
 return null;
}
function withinSourceBoundary(value:ReconstructionAssertion,sources:readonly SourceCoverage[],binding:RuleSourceBinding,now:number){
 const source=sources.find(source=>source.subscriptionId===binding.subscriptionId&&source.sourceNamespace===binding.sourceNamespace);
 const time=value.source.observationKind==='event'?eventInstant(value):value.source.sourceAsOf===null?null:explicitInstant(value.source.sourceAsOf);
 const boundary=source?.completeness.asOf==null?null:explicitInstant(source.completeness.asOf);
 return time!==null&&boundary!==null&&time<=boundary&&time<=now;
}
function result(policy:SourceRulePolicies,category:PresenceCategory,scope:unknown,subject:TypedSourceReference,values:readonly ReconstructionAssertion[],outcome:PresenceOutcome,title:string,explanation:string,deadline:number|null=null):ReconstructionComparison {
 const inputs=[...new Map(values.map(value=>[value.id,value])).values()].sort((a,b)=>a.id.localeCompare(b.id));
 const inputAssertionIds=inputs.map(input=>input.id),issueKey=`case_issue_${sha256Hex(canonicalize({ruleVersion:OPERATIONAL_PRESENCE_RULE_VERSION,policy,category,scope}))}`;
 return {id:`reconstruction_issue_${sha256Hex(canonicalize({issueKey,inputAssertionIds,outcome}))}`,issueKey,category,subject,ruleVersion:OPERATIONAL_PRESENCE_RULE_VERSION,policyVersion:policy.version,outcome,title,explanation,inputAssertionIds,inputs:inputs.map(({id,property,value,source})=>({id,property,value,source})),absoluteDifference:null,baseUnit:null,physicalCondition:'not_established',independence:inputs.some(input=>input.source.copiedFromSource!==null)?'copied':'unknown',deadlineAt:deadline===null?null:new Date(deadline).toISOString()};
}
function policyReadiness(policy:SourceRulePolicies):SourceReadiness {return policy.sourceOwnerQualified&&!!policy.qualificationReference?null:{outcome:'not_comparable',reason:'The source owner has not qualified this exact policy, status vocabulary and timing contract.'};}
function explicitCarrierContext(values:readonly ReconstructionAssertion[],anchor:ReconstructionAssertion,binding:RuleSourceBinding,policy:LabelAcceptancePolicy){
 const rows=values.filter(value=>sameSource(value,binding)&&value.subject.type==='tracking'&&subjectIdentity(value)===subjectIdentity(anchor)&&sameCaseShipment(value,anchor));
 const expected={carrierCode:policy.carrier.code,carrierAccountReference:policy.carrier.accountReference,carrierService:policy.carrier.service};
 const used:ReconstructionAssertion[]=[];
 for(const [property,value]of Object.entries(expected)){
  const assertions=rows.filter(row=>row.property===property),actual=new Set(assertions.map(row=>row.value));
  if(actual.size!==1||!actual.has(value))return null;
  used.push(...assertions);
 }
 return used;
}
const hasFulfillmentModifier=(values:readonly ReconstructionAssertion[],anchor:ReconstructionAssertion)=>values.some(value=>sameCaseShipment(value,anchor)&&((value.property==='status'&&typeof value.value==='string'&&/^(?:voided|cancelled|canceled|backordered|backorder|substituted|replacement|returned)$/i.test(value.value))||(['canceledQuantity','backorderedQuantity','reportedReturnedQuantity'].includes(value.property)&&isQuantity(value.value)&&!/^0(?:\.0+)?$/.test(value.value.amount))));

/** Presence rules require declared source meaning, measured inventory coverage
 * and exact operational context. Receipt times and snapshot-as-of timestamps
 * never become the time that a physical loading or acceptance event occurred. */
export function evaluateOperationalPresenceRules(assertions:readonly ReconstructionAssertion[],sources:readonly SourceCoverage[],context:ReconstructionRuleContext):ReconstructionComparison[] {
 const active=assertions.filter(assertion=>assertion.active),now=context.now instanceof Date?context.now.getTime():explicitInstant(context.now);
 const policies=[...new Map([...(context.policies??[]),...sources.flatMap(source=>source.rulePolicies?[source.rulePolicies]:[])].map(policy=>[canonicalize(policy),policy])).values()];
 const output:ReconstructionComparison[]=[];
 for(const policy of policies){
  if(policy.labelAcceptance)output.push(...evaluateLabels(policy,policy.labelAcceptance,active,sources,now));
  if(policy.handlingUnitHandoff)output.push(...evaluateHandoffs(policy,policy.handlingUnitHandoff,active,sources,now));
 }
 return output.sort((a,b)=>a.issueKey.localeCompare(b.issueKey));
}
function evaluateLabels(policy:SourceRulePolicies,p:LabelAcceptancePolicy,active:readonly ReconstructionAssertion[],sources:readonly SourceCoverage[],now:number|null):ReconstructionComparison[] {
 const groups=new Map<string,ReconstructionAssertion[]>();
 for(const value of active.filter(value=>value.property==='labelStatus'&&value.subject.type==='tracking'&&sameSource(value,p.labelSource)&&operationalNamespace(value)===p.subjectNamespace)){
  const key=canonicalize([value.comparisonScope.caseId??null,subjectIdentity(value),value.comparisonScope.shipment]);groups.set(key,[...(groups.get(key)??[]),value]);
 }
 const output:ReconstructionComparison[]=[];
 for(const [scope,labels]of groups){
  const label=labels[0],emit=(outcome:PresenceOutcome,title:string,explanation:string,inputs:readonly ReconstructionAssertion[]=labels,deadline:number|null=null)=>result(policy,'label_acceptance_gap',scope,label.subject,inputs,outcome,title,explanation,deadline);
  const readiness=policyReadiness(policy)??sourceReadiness(sources,p.labelSource,'tracking_package');
  if(readiness){output.push(emit(readiness.outcome,'Carrier acceptance check unavailable',readiness.reason));continue;}
  if(labels.length!==1||typeof label.value!=='string'||!label.comparisonScope.caseId||!label.comparisonScope.shipment||label.comparisonScope.direction!=='outbound'||now===null||!Number.isFinite(now)){output.push(emit('not_comparable','Label context needs review','One active label status, an explicit case and outbound shipment/package relationship and a valid evaluation clock are required. No approximate tracking-number join is used.'));continue;}
  if(p.labelVoidedValues.includes(label.value)){output.push(withinSourceBoundary(label,sources,p.labelSource,now)?emit('within_tolerance','Source reports the label voided','The qualified label source reports a configured voided status. Carrier acceptance is not expected under this policy; this does not establish a physical shipping outcome.'):emit('not_comparable','Voided label time needs review','The voided status must lie within its qualified source boundary. Unknown or future source times cannot resolve a prior acceptance gap.'));continue;}
  if(!p.labelCreatedValues.includes(label.value)){output.push(emit('not_comparable','Label status meaning is not qualified','The active source status is outside the approved created/voided vocabulary. The rule does not guess its meaning.'));continue;}
  const createdAt=eventInstant(label);
  if(createdAt===null||createdAt>now||!withinSourceBoundary(label,sources,p.labelSource,now)){output.push(emit('not_comparable','Label creation time is unavailable','The label creation status needs an actual source event timestamp within its qualified inventory boundary. A snapshot time or PackProof receipt time is not substituted for label creation.'));continue;}
  const deadline=createdAt+(p.windowSeconds+p.graceSeconds)*1000;
  if(hasFulfillmentModifier(active,label)){output.push(emit('not_comparable','Fulfillment change needs review','A cancellation, backorder, replacement or return changes the applicable shipment question. The rule does not interpret it as an unaccepted shipment.',labels,deadline));continue;}
  const labelCarrier=explicitCarrierContext(active,label,p.labelSource,p);
  if(!labelCarrier){output.push(emit('not_comparable','Carrier account or service context is unresolved','Exact carrier, account and service assertions matching the approved policy are required. Tracking numbers alone are not globally unique.',labels,deadline));continue;}
  const acceptances=active.filter(value=>value.property==='carrierAcceptanceStatus'&&value.subject.type==='tracking'&&sameSource(value,p.acceptanceSource)&&subjectIdentity(value)===subjectIdentity(label)&&sameCaseShipment(value,label)&&operationalNamespace(value)===p.subjectNamespace);
  const input=[label,...labelCarrier,...acceptances];
  const carrier=acceptances.length?explicitCarrierContext(active,label,p.acceptanceSource,p):[];
  if(carrier===null){output.push(emit('not_comparable','Acceptance source context is unresolved','The reported acceptance does not carry a unique matching carrier/account/service context. It cannot resolve this package check.',input,deadline));continue;}
  input.push(...carrier);
  const acceptanceReadiness=sourceReadiness(sources,p.acceptanceSource,'tracking_package');
  if(acceptanceReadiness){output.push(emit(acceptanceReadiness.outcome,'Carrier acceptance check waiting for source data',acceptanceReadiness.reason,input,deadline));continue;}
  if(acceptances.length>1||acceptances.some(value=>typeof value.value!=='string'||!p.acceptedValues.includes(value.value))){output.push(emit('not_comparable','Acceptance status needs review','Multiple or unmapped active carrier statuses prevent a deterministic acceptance conclusion. Source rows remain available.',input,deadline));continue;}
  if(acceptances.length){
   if(acceptances[0].source.copiedFromSource!==null){output.push(emit('not_comparable','Acceptance source lineage needs review','The connected acceptance status declares copied information. It cannot establish an independent carrier acceptance observation or resolve this package check.',input,deadline));continue;}
   const acceptanceAt=eventInstant(acceptances[0]);
   if(acceptanceAt===null||acceptanceAt<createdAt||acceptanceAt>now||!withinSourceBoundary(acceptances[0],sources,p.acceptanceSource,now)){output.push(emit('not_comparable','Acceptance event time needs review','The acceptance observation must contain an actual source event time in the applicable label interval and qualified source boundary. Unknown, inverted or future times are not repaired.',input,deadline));continue;}
   output.push(emit('within_tolerance','Carrier acceptance observation received',`The qualified source reports an acceptance event for this exact carrier/account/service and package.${acceptanceAt>deadline?' Its reported event time is after the approved window; any earlier gap remains in the investigation history.':''} Physical contents and responsibility are not established.`,input,deadline));continue;
  }
  if(now<deadline){output.push(emit('suppressed','Carrier acceptance window is still open','The approved label handoff window and grace period have not elapsed. No missing acceptance finding is emitted yet.',input,deadline));continue;}
  const boundary=sourceReadiness(sources,p.labelSource,'tracking_package',deadline)??sourceReadiness(sources,p.acceptanceSource,'tracking_package',deadline);
  if(boundary){output.push(emit(boundary.outcome,'Carrier acceptance inventory is not reconciled',boundary.reason,input,deadline));continue;}
  output.push(emit('different','No carrier acceptance observation received within the expected window','The nonvoided label event has passed its approved window and grace period. The qualified carrier inventory covers that deadline, but contains no acceptance observation for this exact package, carrier account and service. This is a gap in connected reports, not a finding of nondelivery or physical loss.',input,deadline));
 }
 return output;
}

function handoffContext(value:ReconstructionAssertion,p:HandlingUnitHandoffPolicy){const s=value.comparisonScope;return value.subject.type==='handling_unit'&&operationalNamespace(value)===p.subjectNamespace&&s.caseId&&s.shipment&&s.load&&s.stop&&s.direction==='outbound'?canonicalize([s.caseId,s.shipment,s.load,s.stop,p.subjectNamespace]):null;}
function evaluateHandoffs(policy:SourceRulePolicies,p:HandlingUnitHandoffPolicy,active:readonly ReconstructionAssertion[],sources:readonly SourceCoverage[],now:number|null):ReconstructionComparison[] {
 const expected=active.filter(value=>value.property==='expectedHandoffStatus'&&value.subject.type==='handling_unit'&&sameSource(value,p.expectationSource)&&operationalNamespace(value)===p.subjectNamespace);
 const groups=new Map<string,ReconstructionAssertion[]>();
 for(const value of expected){const key=handoffContext(value,p)??canonicalize(['unresolved',value.comparisonScope.caseId??null,referenceKey(value.subject)]);groups.set(key,[...(groups.get(key)??[]),value]);}
 const output:ReconstructionComparison[]=[];
 for(const [scope,values]of groups){
  const first=values[0],contextKey=handoffContext(first,p);
  const relevant=active.filter(value=>contextKey!==null&&handoffContext(value,p)===contextKey&&['expectedHandoffAt','loadingHandoffStatus','receiptHandoffStatus'].includes(value.property)&&[p.expectationSource,p.loadingSource,p.receiptSource].some(binding=>sameSource(value,binding)));
  const all=[...values,...relevant],emit=(outcome:PresenceOutcome,title:string,explanation:string,deadline:number|null=null)=>result(policy,'handling_unit_handoff_gap',scope,first.subject,all,outcome,title,explanation,deadline);
  const readiness=policyReadiness(policy)??sourceReadiness(sources,p.expectationSource,'handling_unit_set')??sourceReadiness(sources,p.loadingSource,'handling_unit_set')??sourceReadiness(sources,p.receiptSource,'handling_unit_set');
  if(readiness){output.push(emit(readiness.outcome,'Handling-unit handoff check unavailable',readiness.reason));continue;}
  if(contextKey===null||values.some(value=>handoffContext(value,p)!==contextKey)||now===null||!Number.isFinite(now)){output.push(emit('not_comparable','Handling-unit scope is unresolved','Expected units require explicit outbound case, shipment, load and delivery-stop relationships. An aggregate trailer event does not establish package scans.'));continue;}
  if(hasFulfillmentModifier(active,first)){output.push(emit('not_comparable','Changed fulfillment needs handoff review','A cancellation, backorder, replacement or return changes the expected handling-unit set. A qualified adjustment is required before absence reasoning.'));continue;}
  const units=new Map<string,ReconstructionAssertion[]>();for(const value of values){const key=subjectIdentity(value);units.set(key,[...(units.get(key)??[]),value]);}
  if([...units.values()].some(rows=>rows.length!==1||typeof rows[0].value!=='string'||!p.expectedValues.includes(rows[0].value))){output.push(emit('not_comparable','Expected handling-unit inventory needs review','The declared inventory must provide one active, mapped expected status for each explicit handling-unit identity. Unknown statuses and duplicate active expectations are not silently omitted.'));continue;}
  if(all.some(value=>{const source=[p.expectationSource,p.loadingSource,p.receiptSource].find(binding=>sameSource(value,binding));return !source||!withinSourceBoundary(value,sources,source,now);})){output.push(emit('not_comparable','Handling-unit source times need review','Each contributing assertion must lie within its qualified source boundary. Unknown times retained for investigation are not treated as a complete timed handoff inventory.'));continue;}
  const loaded=relevant.filter(value=>value.property==='loadingHandoffStatus'&&sameSource(value,p.loadingSource)),received=relevant.filter(value=>value.property==='receiptHandoffStatus'&&sameSource(value,p.receiptSource));
  const mapped=(rows:ReconstructionAssertion[],vocabulary:string[])=>rows.every(value=>{const at=eventInstant(value);return typeof value.value==='string'&&vocabulary.includes(value.value)&&at!==null&&at<=now!;});
  if(!mapped(loaded,p.loadedValues)||!mapped(received,p.receivedValues)||new Set(loaded.map(subjectIdentity)).size!==loaded.length||new Set(received.map(subjectIdentity)).size!==received.length){output.push(emit('not_comparable','Handling-unit events need review','Loading and receipt reports need one mapped actual event per unit in this exact shipment/load/stop context. Unknown statuses, event times or aggregate load records are not interpreted as package handoffs.'));continue;}
  if(loaded.some(value=>{const receipt=received.find(candidate=>subjectIdentity(candidate)===subjectIdentity(value));return receipt&&eventInstant(receipt)!<eventInstant(value)!;})){output.push(emit('not_comparable','Handling-unit event order needs review','A receipt is reported before its corresponding loading event. The rule preserves both source times and does not repair or reinterpret their sequence.'));continue;}
  const deadlines=new Map<string,number>();let invalidDue=false;
  for(const [unit]of units){const due=relevant.filter(value=>value.property===p.dueAtProperty&&sameSource(value,p.expectationSource)&&subjectIdentity(value)===unit);if(due.length!==1||typeof due[0].value!=='string'||explicitInstant(due[0].value)===null){invalidDue=true;break;}deadlines.set(unit,Date.parse(due[0].value)+(p.windowSeconds+p.graceSeconds)*1000);}
  if(invalidDue){output.push(emit('not_comparable','Planned handoff time is unavailable','Each expected unit needs an explicit source-planned handoff timestamp under the approved policy. A source snapshot or PackProof receipt time is not substituted.'));continue;}
  const loadedIds=new Set(loaded.map(subjectIdentity)),receivedIds=new Set(received.map(subjectIdentity));
  const missingLoaded=[...units.keys()].filter(key=>!loadedIds.has(key)),missingReceipt=[...units.keys()].filter(key=>loadedIds.has(key)&&!receivedIds.has(key)),extra=[...receivedIds].filter(key=>!units.has(key)),extraLoaded=[...loadedIds].filter(key=>!units.has(key));
  const dueMissing=[...missingLoaded,...missingReceipt].filter(key=>now!>=deadlines.get(key)!);
  const deadline=dueMissing.length?Math.max(...dueMissing.map(key=>deadlines.get(key)!)):Math.max(...deadlines.values());
  if(!missingLoaded.length&&!missingReceipt.length&&!extra.length&&!extraLoaded.length){output.push(emit('within_tolerance','Expected handling-unit reports are accounted for','The connected sources report each expected unit loaded and received in this exact case/shipment/load/stop context. These reports do not establish physical contents or responsibility.',deadline));continue;}
  if(!dueMissing.length&&!extra.length&&!extraLoaded.length){output.push(emit('suppressed','Handling-unit handoff window is still open','Some expected unit reports have not arrived, but their explicit planned handoff deadlines and grace periods have not elapsed.',deadline));continue;}
  const boundary=sourceReadiness(sources,p.expectationSource,'handling_unit_set',deadline)??(dueMissing.some(key=>missingLoaded.includes(key))?sourceReadiness(sources,p.loadingSource,'handling_unit_set',deadline):null)??sourceReadiness(sources,p.receiptSource,'handling_unit_set',deadline);
  if(boundary){output.push(emit(boundary.outcome,'Handling-unit inventory is not reconciled',boundary.reason,deadline));continue;}
  const dueLoaded=dueMissing.filter(key=>missingLoaded.includes(key)),dueReceived=dueMissing.filter(key=>missingReceipt.includes(key));
  output.push(emit('different','Handling-unit reports are unaccounted for',`Within this case only, ${dueLoaded.length} expected handling unit(s) have no loading report after their approved deadline; ${dueReceived.length} reported-loaded unit(s) have no receipt report; ${extraLoaded.length} loaded unit(s) and ${extra.length} received unit(s) are outside the qualified expected set. The finding compares explicit source-reported unit identities and inventories. It does not establish where a physical loss occurred, physical contents, or responsibility.`,deadline));
 }
 return output;
}
