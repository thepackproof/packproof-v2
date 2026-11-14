import type {TypedSourceCompleteness} from './source-contracts.js';
import type {SourceRulePolicies} from './source-rule-policy.js';

export type SourceCompletenessScope='shipment_line'|'tracking_package'|'handling_unit_set';

export interface SourceOutcomeCounts {
 received:number;acceptedLinked:number;acceptedUnlinked:number;duplicate:number;
 conflict:number;quarantined:number;rejected:number;processing:number;
}
export interface SourceCoverageInput {
 connectionId:string;sourceNamespace:string;
 state?:'approved'|'active'|'paused'|'revoked';
 lastReceivedAt:string|null;sourceAsOf:string|null;lastCheckedAt:string|null;
 expectedIntervalSeconds:number|null;errorCode?:string|null;
 reportedState?:string|null;collectorBacklog?:number|null;oldestPendingAt?:string|null;collectorPendingAgeUnknownCount?:number|null;collectorRetainedBytes?:number|null;
 completeness:TypedSourceCompleteness;
 completenessPolicy?:{kind:'unknown'|'snapshot'|'sequence';scope:SourceCompletenessScope;sourceOwnerQualified:boolean;qualificationReference?:string|null}|null;
 counts:SourceOutcomeCounts;
}
export interface SourceCoverage {
 displayName?:string;subscriptionId?:string|null;configurationRevision?:number|null;accountingGrain?:'source_subscription';accountingAvailable?:boolean;caseAccounting?:SourceOutcomeCounts;
 connectionId:string;sourceNamespace:string;
 state:'current'|'quiet_checked'|'delayed'|'offline'|'mapping_drift'|'paused'|'coverage_unknown';
 label:string;lastReceivedAt:string|null;sourceAsOf:string|null;lastCheckedAt:string|null;
 expectedIntervalSeconds:number|null;coverage:'qualified'|'unknown';
 collectorBacklog:number|null;oldestPendingAt:string|null;collectorPendingAgeUnknownCount?:number|null;collectorRetainedBytes?:number|null;
 accounting:SourceOutcomeCounts&{reconciled:boolean};nextAction:string;
 rulePolicies?:SourceRulePolicies|null;
 completeness:{kind:TypedSourceCompleteness['kind'];marker:string|null;asOf:string|null;qualificationReference:string|null;scope?:SourceCompletenessScope};
}

/** Reconcile mutually exclusive receipt outcomes. Projection work is separate:
 * an accepted original does not become unreceived when its view is rebuilding. */
export function reconcileSourceAccounting(counts:SourceOutcomeCounts) {
 const values=Object.values(counts);
 const total=counts.acceptedLinked+counts.acceptedUnlinked+counts.duplicate+counts.conflict+counts.quarantined+counts.rejected+counts.processing;
 return {...counts,reconciled:values.every(value=>Number.isSafeInteger(value)&&value>=0)&&total===counts.received};
}

/** Retry measured ingestion/counter work before routine cold-case maintenance.
 * Other unavailable or incomplete source states retain their normal cadence. */
export function sourceWorkRecheckIntervalMs(sources:readonly SourceCoverage[]):number {
 return sources.some(source=>source.accounting.processing>0||source.accountingAvailable===false)?1000:60000;
}

function time(value:string|null):number|null {
 if(value===null)return null;
 const at=Date.parse(value);return Number.isFinite(at)?at:null;
}

/** A recent upload is not source completeness. Only an administrator-approved,
 * source-owner-qualified policy plus the matching measured boundary can support
 * a complete interval. The approved cadence remains a freshness heuristic. */
export function deriveSourceCoverage(input:SourceCoverageInput,now:Date):SourceCoverage {
 const accounting=reconcileSourceAccounting(input.counts),policy=input.completenessPolicy;
 const interval=input.expectedIntervalSeconds;
 const validInterval=typeof interval==='number'&&Number.isInteger(interval)&&interval>=60&&interval<=604800;
 const boundary=time(input.completeness.asOf),checked=time(input.lastCheckedAt),asOf=time(input.sourceAsOf);
 const validTimes=[boundary,checked,asOf].every(value=>value!==null&&value<=now.getTime());
 const qualified=!!policy&&policy.sourceOwnerQualified===true&&!!policy.qualificationReference?.trim()&&['shipment_line','tracking_package','handling_unit_set'].includes(policy.scope)&&policy.kind!=='unknown'&&policy.kind===input.completeness.kind&&!!input.completeness.marker&&validTimes;
 const base={connectionId:input.connectionId,sourceNamespace:input.sourceNamespace,lastReceivedAt:input.lastReceivedAt,sourceAsOf:input.sourceAsOf,lastCheckedAt:input.lastCheckedAt,expectedIntervalSeconds:interval,coverage:qualified?'qualified':'unknown',accounting,collectorBacklog:input.collectorBacklog??null,oldestPendingAt:input.oldestPendingAt??null,collectorPendingAgeUnknownCount:input.collectorPendingAgeUnknownCount??null,collectorRetainedBytes:input.collectorRetainedBytes??null,
  completeness:{...input.completeness,qualificationReference:qualified?policy!.qualificationReference!:null,...(policy?{scope:policy.scope}:{})}} as const;
 if(input.state==='paused'||input.state==='revoked')return {...base,state:'paused',label:input.state==='revoked'?'Source authorization revoked':'Source paused',nextAction:'Ask a source administrator to review current authorization.'};
 if(input.reportedState==='mapping_drift'||input.errorCode&&/SCHEMA|MAPPING|DRIFT|QUARANTIN/i.test(input.errorCode))return {...base,state:'mapping_drift',label:'Source mapping needs review',nextAction:'Review the changed source contract. Other approved sources can continue.'};
 if(input.reportedState==='source_unreadable')return {...base,state:'offline',label:'Source is unreadable',nextAction:'Review source access and reconcile the affected interval.'};
 if(input.errorCode)return {...base,state:'offline',label:'Source check failed',nextAction:'Review source access and reconcile the affected interval.'};
 if(input.reportedState==='storage_pressure'||Number(input.collectorBacklog??0)>0)return {...base,state:'coverage_unknown',label:'Collected source work is pending',nextAction:'Review retained backlog and storage capacity; source collection is not yet reconciled.'};
 if(input.state!==undefined&&input.state!=='active')return {...base,state:'coverage_unknown',label:'Recurring source collection is not active',nextAction:'Review the first source record and approve recurring collection separately.'};
 if(!accounting.reconciled)return {...base,state:'coverage_unknown',label:'Receipt accounting needs reconciliation',nextAction:'Reconcile retained inputs before relying on this source interval.'};
 if(!validInterval||!validTimes||!qualified)return {...base,state:'coverage_unknown',label:'Source coverage unknown',nextAction:'Qualify the source boundary and cadence with its owner. Received data remains available.'};
 const oldest=Math.min(boundary!,checked!,asOf!);
 if(input.reportedState==='delayed'||now.getTime()-oldest>interval!*1000)return {...base,state:'delayed',label:'Source updates delayed',nextAction:'Reconcile source updates; missing observations do not establish missing goods.'};
 if(input.counts.processing||input.counts.acceptedUnlinked)return {...base,state:'coverage_unknown',label:'Source reconstruction pending',nextAction:'Review unresolved associations and pending receipt outcomes.'};
 if(input.counts.conflict||input.counts.quarantined||input.counts.rejected)return {...base,state:'coverage_unknown',label:'Source interpretation incomplete',nextAction:'Review conflicted, quarantined and rejected inputs before treating this source interval as complete.'};
 const last=time(input.lastReceivedAt);
 if(last===null||checked!>last)return {...base,state:'quiet_checked',label:'Source checked without new data',nextAction:'No changes were reported. This does not establish that no warehouse activity occurred.'};
 return {...base,state:'current',label:'Source current through the qualified boundary',nextAction:'View the source-attributed records.'};
}
