import {DomainError} from '../domain/errors.js';
import {strictBody} from '../platform/organizations.js';

export const SOURCE_RULE_POLICY_SCHEMA='packproof.source-rule-policies/v1' as const;
export interface RuleSourceBinding {subscriptionId:string;configurationRevision:number;sourceNamespace:string;}
export interface LabelAcceptancePolicy {
 labelSource:RuleSourceBinding;acceptanceSource:RuleSourceBinding;subjectNamespace:string;
 carrier:{code:string;accountReference:string;service:string};
 windowSeconds:number;graceSeconds:number;
 labelCreatedValues:string[];labelVoidedValues:string[];acceptedValues:string[];
}
export interface HandlingUnitHandoffPolicy {
 expectationSource:RuleSourceBinding;loadingSource:RuleSourceBinding;receiptSource:RuleSourceBinding;
 subjectNamespace:string;scope:'case_shipment_stop';dueAtProperty:'expectedHandoffAt';
 windowSeconds:number;graceSeconds:number;expectedValues:string[];loadedValues:string[];receivedValues:string[];
}
export interface SourceRulePolicies {
 schema:typeof SOURCE_RULE_POLICY_SCHEMA;version:string;sourceOwnerQualified:boolean;qualificationReference:string|null;
 labelAcceptance?:LabelAcceptancePolicy;handlingUnitHandoff?:HandlingUnitHandoffPolicy;
}
const invalid=(message:string):never=>{throw new DomainError('INVALID_SOURCE_RULE_POLICY',message,400);};
function exactText(value:unknown,name:string,max=200){if(typeof value!=='string'||!value.length||value!==value.trim()||value.length>max)invalid(`${name} must be an exact, nonempty string of at most ${max} characters`);return value as string;}
function binding(value:unknown):RuleSourceBinding {
 const b=strictBody(value,['subscriptionId','configurationRevision','sourceNamespace']);
 if(!Number.isSafeInteger(b.configurationRevision)||Number(b.configurationRevision)<1)invalid('Each rule source must bind a positive approved configuration revision');
 return {subscriptionId:exactText(b.subscriptionId,'subscriptionId'),configurationRevision:Number(b.configurationRevision),sourceNamespace:exactText(b.sourceNamespace,'sourceNamespace')};
}
function seconds(value:unknown,name:string,max:number){if(!Number.isSafeInteger(value)||Number(value)<0||Number(value)>max)invalid(`${name} must be an integer from zero to ${max} seconds`);return Number(value);}
function vocabulary(value:unknown,name:string,allowEmpty=false){if(!Array.isArray(value)||(!allowEmpty&&!value.length)||value.length>30)invalid(`Declare ${name} with ${allowEmpty?'zero':'one'} to 30 exact source values`);const result=(value as unknown[]).map(v=>exactText(v,name,100));if(new Set(result).size!==result.length)invalid(`${name} cannot contain duplicate values`);return result;}

/** A policy declares source meaning; it never authenticates that meaning by
 * itself. Approval must bind every referenced source within current site,
 * organization, operator and configuration scope before this policy is used. */
export function parseSourceRulePolicies(input:unknown):SourceRulePolicies|null {
 if(input==null)return null;
 const p=strictBody(input,['schema','version','sourceOwnerQualified','qualificationReference','labelAcceptance','handlingUnitHandoff']);
 if(p.schema!==SOURCE_RULE_POLICY_SCHEMA)invalid('Use the supported versioned operational rule policy schema');
 if(typeof p.sourceOwnerQualified!=='boolean')invalid('Declare whether the source owner has qualified this exact policy');
 const qualificationReference=p.qualificationReference==null?null:exactText(p.qualificationReference,'qualificationReference',500);
 if(p.sourceOwnerQualified&&!qualificationReference)invalid('A qualified rule requires a documented source-owner qualification reference');
 const result:SourceRulePolicies={schema:SOURCE_RULE_POLICY_SCHEMA,version:exactText(p.version,'version'),sourceOwnerQualified:p.sourceOwnerQualified as boolean,qualificationReference};
 if(p.labelAcceptance!=null){
  const v=strictBody(p.labelAcceptance,['labelSource','acceptanceSource','subjectNamespace','carrier','windowSeconds','graceSeconds','labelCreatedValues','labelVoidedValues','acceptedValues']);
  const c=strictBody(v.carrier,['code','accountReference','service']);
  const labelCreatedValues=vocabulary(v.labelCreatedValues,'labelCreatedValues'),labelVoidedValues=vocabulary(v.labelVoidedValues,'labelVoidedValues',true);
  if(labelCreatedValues.some(code=>labelVoidedValues.includes(code)))invalid('A label source value cannot mean both created and voided');
  result.labelAcceptance={labelSource:binding(v.labelSource),acceptanceSource:binding(v.acceptanceSource),subjectNamespace:exactText(v.subjectNamespace,'subjectNamespace'),carrier:{code:exactText(c.code,'carrier.code',100),accountReference:exactText(c.accountReference,'carrier.accountReference'),service:exactText(c.service,'carrier.service',100)},windowSeconds:seconds(v.windowSeconds,'windowSeconds',30*86400),graceSeconds:seconds(v.graceSeconds,'graceSeconds',7*86400),labelCreatedValues,labelVoidedValues,acceptedValues:vocabulary(v.acceptedValues,'acceptedValues')};
 }
 if(p.handlingUnitHandoff!=null){
  const v=strictBody(p.handlingUnitHandoff,['expectationSource','loadingSource','receiptSource','subjectNamespace','scope','dueAtProperty','windowSeconds','graceSeconds','expectedValues','loadedValues','receivedValues']);
  if(v.scope!=='case_shipment_stop'||v.dueAtProperty!=='expectedHandoffAt')invalid('Handling-unit rules require a case/shipment/stop scope and an explicit planned handoff timestamp');
  result.handlingUnitHandoff={expectationSource:binding(v.expectationSource),loadingSource:binding(v.loadingSource),receiptSource:binding(v.receiptSource),subjectNamespace:exactText(v.subjectNamespace,'subjectNamespace'),scope:'case_shipment_stop',dueAtProperty:'expectedHandoffAt',windowSeconds:seconds(v.windowSeconds,'windowSeconds',30*86400),graceSeconds:seconds(v.graceSeconds,'graceSeconds',7*86400),expectedValues:vocabulary(v.expectedValues,'expectedValues'),loadedValues:vocabulary(v.loadedValues,'loadedValues'),receivedValues:vocabulary(v.receivedValues,'receivedValues')};
 }
 if(!result.labelAcceptance&&!result.handlingUnitHandoff)invalid('Declare at least one explicit operational rule or leave rule policies absent');
 referencedRuleSources(result);
 return result;
}

/** Used by grant approval and case readers. Returning declared IDs never grants
 * permission to read them; those callers must apply their current scope first. */
export function referencedRuleSources(policy:SourceRulePolicies|null|undefined):RuleSourceBinding[] {
 if(!policy)return [];
 const all=[...(policy.labelAcceptance?[policy.labelAcceptance.labelSource,policy.labelAcceptance.acceptanceSource]:[]),...(policy.handlingUnitHandoff?[policy.handlingUnitHandoff.expectationSource,policy.handlingUnitHandoff.loadingSource,policy.handlingUnitHandoff.receiptSource]:[])];
 const ids=new Map<string,RuleSourceBinding>();
 for(const value of all){const prior=ids.get(value.subscriptionId);if(prior&&(prior.configurationRevision!==value.configurationRevision||prior.sourceNamespace!==value.sourceNamespace))invalid('One policy cannot bind the same source subscription to contradictory versions or namespaces');ids.set(value.subscriptionId,value);}
 return [...ids.values()].sort((a,b)=>a.subscriptionId.localeCompare(b.subscriptionId));
}
