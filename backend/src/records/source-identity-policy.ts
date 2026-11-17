import {DomainError} from '../domain/errors.js';
import {strictBody} from '../platform/organizations.js';
import type {SourceProfileId,SourceCsvFieldV2} from './source-profiles.js';

export const SOURCE_IDENTITY_POLICY='packproof.source-identity-policy/v1' as const;
export const COMPOSITE_SOURCE_ID_PREFIX='composite:v1:' as const;
export const IMMUTABLE_EVENT_REVISION='immutable-event/v1' as const;
export const SOURCE_IDENTITY_FIELDS=['sourceEventId','sourceSequence','orderId','orderLineId','shipmentId','handlingUnitId','loadId','stopId','returnId','productId','serialId','trackingId','property'] as const;
export type SourceIdentityField=typeof SOURCE_IDENTITY_FIELDS[number];
export interface SourceIdentityPolicy {
 schema:typeof SOURCE_IDENTITY_POLICY;
 eventKey:{kind:'column'}|{kind:'composite';fields:SourceIdentityField[]};
 revision:{kind:'column'}|{kind:'source_as_of'}|{kind:'immutable_event'};
}
const invalid=(message:string)=>new DomainError('INVALID_SOURCE_IDENTITY_POLICY',message,400);
export function parseSourceIdentityPolicy(input:unknown):SourceIdentityPolicy {
 const p=strictBody(input,['schema','eventKey','revision']);
 if(p.schema!==SOURCE_IDENTITY_POLICY)throw invalid('Choose the documented source identity policy version.');
 const key=strictBody(p.eventKey,['kind','fields']),revision=strictBody(p.revision,['kind']);
 if(key.kind!=='column'&&key.kind!=='composite')throw invalid('Choose an explicit source identity column or an approved composite key.');
 if(!['column','source_as_of','immutable_event'].includes(String(revision.kind)))throw invalid('Choose an explicit revision column, reported snapshot boundary, or immutable-event contract.');
 if(key.kind==='column'&&key.fields!==undefined)throw invalid('A column identity does not accept composite components.');
 if(key.kind==='composite'){
  if(!Array.isArray(key.fields)||key.fields.length<2||key.fields.length>8||new Set(key.fields).size!==key.fields.length||key.fields.some(f=>!SOURCE_IDENTITY_FIELDS.includes(f as SourceIdentityField)))throw invalid('Choose two to eight distinct source identity components. Values, timestamps and file hashes cannot be business identity components.');
  return {schema:SOURCE_IDENTITY_POLICY,eventKey:{kind:'composite',fields:[...key.fields] as SourceIdentityField[]},revision:{kind:revision.kind as SourceIdentityPolicy['revision']['kind']}};
 }
 return {schema:SOURCE_IDENTITY_POLICY,eventKey:{kind:'column'},revision:{kind:revision.kind as SourceIdentityPolicy['revision']['kind']}};
}
export function validateSourceIdentityMapping(policy:SourceIdentityPolicy,mapping:Partial<Record<SourceCsvFieldV2,string>>,constants:Partial<Record<string,string>>,profile:SourceProfileId){
 if(policy.eventKey.kind==='column'){
  if(!mapping.sourceEventId)throw invalid('The approved column identity requires its actual sourceEventId column.');
 }else{
  const fields=policy.eventKey.fields;
  for(const field of fields)if(!mapping[field]&&!(field==='property'&&constants.property))throw invalid(`Map the actual ${field} key component before approving this source.`);
  const required=profile==='packproof.order-lines/v1'?['orderId','orderLineId','property']:profile==='packproof.shipment-handling-units/v1'?['orderId','orderLineId','shipmentId','property']:['shipmentId','property'];
  for(const field of required)if(!fields.includes(field as SourceIdentityField))throw invalid(`The ${profile} row grain requires ${field} in its composite identity.`);
  if(mapping.orderLineId)for(const field of ['orderId','orderLineId'])if(!fields.includes(field as SourceIdentityField))throw invalid(`An observed order-line grain requires ${field} in its composite identity.`);
  for(const field of SOURCE_IDENTITY_FIELDS.filter(f=>f!=='sourceEventId'&&f!=='sourceSequence'&&f!=='property'))if(mapping[field]&&!fields.includes(field))throw invalid(`The mapped ${field} identifies the observed row grain and must be retained in its composite identity.`);
  if(profile==='packproof.operational-observations/v2'){
   const property=constants.property;
   if(property&&['labelStatus','carrierCode','carrierAccountReference','carrierService','carrierAcceptanceStatus'].includes(property)&&!fields.includes('trackingId'))throw invalid('A tracking assertion requires trackingId in its composite identity.');
   if(property&&['expectedHandoffStatus','loadingHandoffStatus','receiptHandoffStatus','expectedHandoffAt'].includes(property)&&!fields.includes('handlingUnitId'))throw invalid('A handling-unit assertion requires handlingUnitId in its composite identity.');
  }
 }
 if(policy.revision.kind==='column'&&!mapping.sourceRevision)throw invalid('Map the actual sourceRevision column before approving this policy.');
 if(policy.revision.kind!=='column'&&mapping.sourceRevision)throw invalid('Do not map a source revision column while selecting a different revision basis.');
 if(policy.revision.kind==='source_as_of'&&!mapping.sourceAsOf)throw invalid('A snapshot revision requires an actual sourceAsOf column.');
 const kind=constants.observationKind;
 if(kind==='event'&&policy.revision.kind==='source_as_of')throw invalid('An event cannot obtain identity from a snapshot boundary.');
 if(kind&&kind!=='event'&&policy.revision.kind==='immutable_event')throw invalid('Only explicitly immutable events may use the immutable-event revision contract.');
 if(kind==='event'&&policy.eventKey.kind==='composite'&&!policy.eventKey.fields.some(f=>f==='sourceEventId'||f==='sourceSequence'))throw invalid('An event composite key requires an actual event ID or source event sequence component; timestamp proximity is not identity.');
}
/** Length-prefixed exact strings make delimiters and leading zeros unambiguous.
 * This key contains the approved business components; it is not a content hash. */
export function compositeSourceEventId(fields:readonly SourceIdentityField[],get:(field:SourceIdentityField)=>string|null):string {
 const parts=fields.map(field=>{
  const value=get(field);
  if(typeof value!=='string'||!value.trim()||value.includes('\0')||value.length>200)throw invalid(`The source row is missing a bounded ${field} identity component.`);
  return `${field.length}:${field}${Buffer.byteLength(value,'utf8')}:${value}`;
 });
 const result=COMPOSITE_SOURCE_ID_PREFIX+parts.join('');
 if(Buffer.byteLength(result,'utf8')>1024)throw invalid('The approved composite source identity exceeds 1,024 UTF-8 bytes.');
 return result;
}
