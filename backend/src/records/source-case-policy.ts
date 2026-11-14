import {DomainError} from '../domain/errors.js';
import {strictBody} from '../platform/organizations.js';

export interface CrossCaseSourcePolicy {
 schema:'packproof.cross-case-source-policy/v1';version:string;
 allowMultiOrderRows:true;partitionRule:'explicit_order_line_allocations';
 sharedEntityTypes:('handling_unit'|'load'|'stop')[];
 sourceOwnerQualified:true;qualificationReference:string;
}
/** Scope is declared by the source owner. A shared ID seen in two unrelated
 * receipts never becomes a cross-order link by itself. */
export function parseCrossCaseSourcePolicy(input:unknown):CrossCaseSourcePolicy {
 const b=strictBody(input,['schema','version','allowMultiOrderRows','partitionRule','sharedEntityTypes','sourceOwnerQualified','qualificationReference']);
 const invalid=()=>new DomainError('INVALID_CROSS_CASE_POLICY','Approve a versioned, source-qualified explicit order allocation policy',400);
 if(b.schema!=='packproof.cross-case-source-policy/v1'||b.allowMultiOrderRows!==true||b.partitionRule!=='explicit_order_line_allocations'||b.sourceOwnerQualified!==true)throw invalid();
 for(const v of [b.version,b.qualificationReference])if(typeof v!=='string'||!v.trim()||v!==v.trim()||v.length>500)throw invalid();
 if(!Array.isArray(b.sharedEntityTypes)||!b.sharedEntityTypes.length||b.sharedEntityTypes.length>3||new Set(b.sharedEntityTypes).size!==b.sharedEntityTypes.length||b.sharedEntityTypes.some(v=>!['handling_unit','load','stop'].includes(String(v))))throw invalid();
 return b as unknown as CrossCaseSourcePolicy;
}
