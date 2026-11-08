import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';

/** Located exporter IDs are a separate namespace. Unlocated legacy IDs keep
 * their existing binding. The original display ID is retained in the record. */
export function shipmentBindingKey(externalId:string,locationId:string|null) {
  return locationId ? `location:v1:${sha256Hex(canonicalize({externalId,locationId}))}` : externalId;
}
export const SOURCE_REFERENCE_RULE='packproof.source-reference/v1';
export interface SourceReference { type:'SHIPMENT'|'ORDER'|'RETURN'|'package'|'pallet'|'item'; externalId:string; }
export interface SourceResolution {outcome:'linked'|'unresolved_no_match'|'unresolved_ambiguous';proofId:string|null;candidates:string[];ruleVersion:string;basis:string;}
/** Precedence is explicit and deterministic. Approximate identities, tracking
 * numbers and clocks are intentionally absent from the matching input. */
export function decideSourceReference(direct:string[],crosswalk:string[],children:string[]):SourceResolution {
  const basis=direct.length?'immutable_binding':crosswalk.length?'approved_crosswalk':'unique_bound_child';
  const candidates=[...new Set(direct.length?direct:crosswalk.length?crosswalk:children)].sort();
  return {outcome:candidates.length===1?'linked':candidates.length?'unresolved_ambiguous':'unresolved_no_match',proofId:candidates.length===1?candidates[0]:null,candidates,ruleVersion:SOURCE_REFERENCE_RULE,basis};
}
