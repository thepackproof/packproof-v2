import {canonicalize} from '../canonical.js';
import type {TypedSourceReference} from './source-contracts.js';
import type {CaseIdentityAliasView,CaseIdentityRuleView} from './cases.js';

export interface ProjectionIdentityMappings {aliases:CaseIdentityAliasView[];rules:CaseIdentityRuleView[];}
const key=(r:TypedSourceReference)=>canonicalize([r.namespace,r.type,r.externalId,r.parentExternalId??null]);
function effective(mapping:{effectiveFrom:string|null;effectiveUntil:string|null},at:string|null){
 if(mapping.effectiveFrom===null&&mapping.effectiveUntil===null)return true;
 if(at===null||!Number.isFinite(Date.parse(at)))return false;
 const time=Date.parse(at);return (mapping.effectiveFrom===null||time>=Date.parse(mapping.effectiveFrom))&&(mapping.effectiveUntil===null||time<Date.parse(mapping.effectiveUntil));
}
/** The closure follows only approved exact mappings. Unknown source time cannot
 * cross a time-limited alias, and raw identifiers remain in source provenance. */
export function projectionReferenceResolver(mappings:ProjectionIdentityMappings,at:string|null){
 const aliases=mappings.aliases.filter(m=>effective(m,at)),rules=mappings.rules.filter(m=>effective(m,at)),explicitEndpoints=new Set(aliases.flatMap(m=>[key(m.left.reference),key(m.right.reference)]));
 return (ref:TypedSourceReference)=>{
  const found=new Map<string,TypedSourceReference>([[key(ref),ref]]),queue=[ref],applied=new Map<string,CaseIdentityAliasView|CaseIdentityRuleView>();
  for(let index=0;index<queue.length;index++){
   const current=queue[index],currentKey=key(current);
   const add=(next:TypedSourceReference,m:CaseIdentityAliasView|CaseIdentityRuleView)=>{const id=key(next);applied.set(m.id,m);if(!found.has(id)){found.set(id,next);queue.push(next);}};
   for(const mapping of aliases){if(key(mapping.left.reference)===currentKey)add(mapping.right.reference,mapping);if(key(mapping.right.reference)===currentKey)add(mapping.left.reference,mapping);}
   for(const mapping of rules)if(mapping.type===current.type&&!explicitEndpoints.has(currentKey)){const next=mapping.leftNamespace===current.namespace?{...current,namespace:mapping.rightNamespace}:mapping.rightNamespace===current.namespace?{...current,namespace:mapping.leftNamespace}:null;if(next&&!explicitEndpoints.has(key(next)))add(next,mapping);}
  }
  const canonical=[...found].sort(([a],[b])=>a<b?-1:a>b?1:0)[0];
  return {key:canonical[0],reference:canonical[1],basis:[...applied.values()].sort((a,b)=>a.id.localeCompare(b.id)).map(m=>({id:m.id,revisionHash:m.revisionHash,ruleVersion:m.ruleVersion,reason:m.reason,approvedBy:m.approvedBy,approvedAt:m.approvedAt,effectiveFrom:m.effectiveFrom,effectiveUntil:m.effectiveUntil}))};
 };
}
export const identityMappingDependencies=(m:ProjectionIdentityMappings)=>({aliases:m.aliases.map(a=>[a.id,a.revisionHash]),rules:m.rules.map(r=>[r.id,r.revisionHash])});
