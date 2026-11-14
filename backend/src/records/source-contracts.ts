import type {Quantity} from './quantities.js';
import {TYPED_SOURCE_SCHEMA,TYPED_SOURCE_SCHEMA_V2,type TypedSourceSchema,type SourceProfileId,type SourceEntityType,type SourceProperty,type SourceRelationshipType,type SourceCsvFieldV2} from './source-profiles.js';
import {parseSourceIdentityPolicy,validateSourceIdentityMapping,compositeSourceEventId,IMMUTABLE_EVENT_REVISION,type SourceIdentityPolicy} from './source-identity-policy.js';
export {parseSourceIdentityPolicy,validateSourceIdentityMapping,type SourceIdentityPolicy} from './source-identity-policy.js';
export interface TypedSourceReference {namespace:string;type:SourceEntityType;externalId:string;parentExternalId?:string}
export interface TypedSourceLocator {row:number;field:string;jsonPointer?:string}
export interface TypedSourceAssertion {subjectReference:TypedSourceReference;property:SourceProperty;value:Quantity|string;sourceLocator:TypedSourceLocator;assurance:'source_reported'}
export interface TypedSourceRelationship {from:TypedSourceReference;to:TypedSourceReference;type:SourceRelationshipType;quantity:Quantity|null}
export interface SourceIdentityDerivation {
 schema:'packproof.source-identity-derivation/v1';
 eventKey:{kind:'column'|'composite';components:{field:string;value:string;sourceLocator:TypedSourceLocator|null;approvedConstant:boolean}[]};
 revision:{kind:'column'|'source_as_of'|'immutable_event';sourceValue:string|null;sourceLocator:TypedSourceLocator|null};
}
export interface TypedSourceObservation {
 identityDerivation?:SourceIdentityDerivation;
 sourceEventId:string;sourceRevision:string;observationKind:'event'|'snapshot'|'correction'|'tombstone';
 occurredAt:string|null;sourceAsOf:string|null;timeQuality:'event_time'|'snapshot_time_only'|'unknown';
 references:TypedSourceReference[];assertions:TypedSourceAssertion[];relationships:TypedSourceRelationship[];
 supersedes:{sourceEventId:string;sourceRevision:string}|null;
 originSystem:string|null;copiedFromSource:string|null;
}
export interface TypedSourceRow {index:number;rowNumber:number;raw:unknown;normalized:TypedSourceObservation|null;errors:string[];payloadSha256:string|null}
export interface TypedSourceCompleteness {kind:'unknown'|'snapshot'|'sequence';asOf:string|null;marker:string|null}
export interface TypedSourceBatch {
 schema:TypedSourceSchema;connectionId:string;locationId:string;sourceProfile:SourceProfileId;mappingVersion:string;sourceNamespace:string;
 subscriptionId:string|null;configurationRevision:number|null;grantRevision:number|null;wholeFileConsent:true;
 original:{name:string;mediaType:'text/csv'|'application/json';content:string;sha256:string};
 mapping:Partial<Record<SourceCsvFieldV2,string>>;constants:Partial<Record<'observationKind'|'property'|'timeQuality',string>>;
 identityPolicy?:SourceIdentityPolicy;
 completeness:TypedSourceCompleteness;headers:string[];rows:TypedSourceRow[];
}

import {DomainError} from '../domain/errors.js';
import {strictBody} from '../platform/organizations.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {quantity} from './quantities.js';
import {parseCsv} from './csv.js';
import {explicitInstant} from './csv-semantics.js';
import {ALL_SOURCE_PROFILES,SOURCE_CONTRACT_VERSION,TYPED_SOURCE_LIMITS,SOURCE_ENTITY_TYPES,SOURCE_PROPERTIES,SOURCE_PROPERTIES_V2,SOURCE_QUANTITY_PROPERTIES,SOURCE_RELATIONSHIP_TYPES,TYPED_SOURCE_RULES,sourceProfilesForSchema,sourceCsvFieldsForSchema} from './source-profiles.js';
export {SOURCE_CONTRACT_VERSION};
const invalid=(message:string)=>new DomainError('INVALID_TYPED_SOURCE',message,400);
function text(value:unknown,field:string,max=200):string {
 if(typeof value!=='string'||!value.trim()||value.length>max||value.includes('\0'))throw invalid(`${field} must be a nonempty string of at most ${max} characters.`);
 return value;
}
function optionalText(value:unknown,field:string,max=200):string|null {return value===undefined||value===null||value===''?null:text(value,field,max);}
function oneOf<T extends string>(value:unknown,allowed:readonly T[],field:string):T {if(typeof value!=='string'||!allowed.includes(value as T))throw invalid(`${field} must use the documented vocabulary.`);return value as T;}
function stamp(value:unknown,field:string):string|null {
 if(value===undefined||value===null||value==='')return null;
 const raw=text(value,field,64);
 if(explicitInstant(raw)===null)throw invalid(`${field} requires a valid ISO timestamp with seconds and an explicit UTC offset; local times are not inferred.`);
 return raw;
}
export function sourceReferenceKey(ref:TypedSourceReference):string {return canonicalize(ref);}
/** Business identity excludes a physical row locator: the same immutable source
 * observation may legitimately move within another retained original. */
const ordinal=(a:string,b:string)=>a<b?-1:a>b?1:0;
export function canonicalSourceObservation(observation:TypedSourceObservation):string {
 const assertions=observation.assertions.map(({sourceLocator:_,...a})=>a).sort((a,b)=>ordinal(canonicalize(a),canonicalize(b)));
 const references=[...observation.references].sort((a,b)=>ordinal(sourceReferenceKey(a),sourceReferenceKey(b)));
 const relationships=[...observation.relationships].sort((a,b)=>ordinal(canonicalize(a),canonicalize(b)));
 const identityDerivation=observation.identityDerivation?{...observation.identityDerivation,eventKey:{...observation.identityDerivation.eventKey,components:observation.identityDerivation.eventKey.components.map(({sourceLocator:_,...component})=>component)},revision:(({sourceLocator:_,...revision})=>({...revision,sourceValue:revision.kind==='source_as_of'&&revision.sourceValue?new Date(revision.sourceValue).toISOString():revision.sourceValue}))(observation.identityDerivation.revision)}:undefined;
 return canonicalize({...observation,...(identityDerivation?{identityDerivation,...(identityDerivation.revision.kind==='source_as_of'&&observation.sourceAsOf?{sourceAsOf:new Date(observation.sourceAsOf).toISOString()}:{})}:{}),references,assertions,relationships});
}
function reference(input:unknown,namespace:string):TypedSourceReference {
 const b=strictBody(input,['namespace','type','externalId','parentExternalId']);
 const value:TypedSourceReference={namespace:text(b.namespace,'reference namespace'),type:oneOf(b.type,SOURCE_ENTITY_TYPES,'reference type'),externalId:text(b.externalId,'reference externalId')};
 if(value.type==='order_line')value.parentExternalId=text(b.parentExternalId,'order_line parentExternalId');
 else if(b.parentExternalId!=null)throw invalid('Only an order_line reference accepts a parentExternalId in this version.');
 // Cross-namespace linkage is an approved server crosswalk, never an arbitrary
 // reference in a submitted row. Sources may share a declared namespace only
 // when their immutable approved subscriptions explicitly bind it.
 if(value.namespace!==namespace)throw invalid('References must use the approved source namespace; cross-source links require an approved crosswalk.');
 return value;
}
function parseObservation(input:unknown,rowNumber:number,index:number,namespace:string,profile:SourceProfileId,transport:'text/csv'|'application/json',schema:TypedSourceSchema):TypedSourceObservation {
 const b=strictBody(input,['sourceEventId','sourceRevision','observationKind','occurredAt','sourceAsOf','timeQuality','references','assertions','relationships','supersedes','originSystem','copiedFromSource']);
 const sourceEventId=text(b.sourceEventId,'sourceEventId',schema===TYPED_SOURCE_SCHEMA?200:2048),sourceRevision=text(b.sourceRevision,'sourceRevision',100),observationKind=oneOf(b.observationKind,['event','snapshot','correction','tombstone'] as const,'observationKind');
 if(schema===TYPED_SOURCE_SCHEMA_V2&&Buffer.byteLength(sourceEventId,'utf8')>1024)throw invalid('The source event identity exceeds 1,024 UTF-8 bytes.');
 if(schema===TYPED_SOURCE_SCHEMA_V2&&Buffer.byteLength(sourceRevision,'utf8')>200)throw invalid('The source revision exceeds 200 UTF-8 bytes.');
 const occurredAt=stamp(b.occurredAt,'occurredAt'),sourceAsOf=stamp(b.sourceAsOf,'sourceAsOf'),timeQuality=oneOf(b.timeQuality,['event_time','snapshot_time_only','unknown'] as const,'timeQuality');
 if(timeQuality==='event_time'&&!occurredAt)throw invalid('event_time requires occurredAt.');
 if(timeQuality==='snapshot_time_only'&&(!sourceAsOf||occurredAt))throw invalid('snapshot_time_only requires sourceAsOf and an unknown occurredAt.');
 if(timeQuality==='unknown'&&(occurredAt||sourceAsOf))throw invalid('Unknown time quality cannot carry interpreted event or as-of times.');
 if(observationKind==='event'&&(timeQuality!=='event_time'||!occurredAt))throw invalid('Events require a source-reported occurredAt; snapshots cannot invent a physical event time.');
 if(!Array.isArray(b.references)||!b.references.length||b.references.length>TYPED_SOURCE_LIMITS.referencesPerRow)throw invalid('Supply 1 to 20 explicit typed source references.');
 const references=b.references.map(x=>reference(x,namespace)),keys=new Set(references.map(sourceReferenceKey));
 if(keys.size!==references.length)throw invalid('Duplicate entity references are not permitted in a row.');
 const required=ALL_SOURCE_PROFILES.find(p=>p.id===profile)!.requiredReferences;
 for(const kind of required)if(!references.some(r=>r.type===kind))throw invalid(`${profile} requires an explicit ${kind} reference.`);
 if(profile.startsWith('packproof.operational-observations/')&&!references.some(r=>['order','order_line','shipment','handling_unit','return'].includes(r.type)))throw invalid('Operational observations require an explicit operational subject, not only a load or tracking number.');
 let supersedes:TypedSourceObservation['supersedes']=null;
 if(b.supersedes!=null){const old=strictBody(b.supersedes,['sourceEventId','sourceRevision']);supersedes={sourceEventId:text(old.sourceEventId,'supersedes.sourceEventId',schema===TYPED_SOURCE_SCHEMA?200:2048),sourceRevision:text(old.sourceRevision,'supersedes.sourceRevision',100)};if(supersedes.sourceEventId===sourceEventId&&supersedes.sourceRevision===sourceRevision)throw invalid('A revision cannot supersede itself.');}
 if(schema===TYPED_SOURCE_SCHEMA_V2&&supersedes&&Buffer.byteLength(supersedes.sourceRevision,'utf8')>200)throw invalid('The superseded source revision exceeds 200 UTF-8 bytes.');
 if((observationKind==='correction'||observationKind==='tombstone')&&!supersedes)throw invalid('Corrections and tombstones require an explicit superseded source identity and revision.');
 if(!Array.isArray(b.assertions)||b.assertions.length>TYPED_SOURCE_LIMITS.assertionsPerRow||(observationKind!=='tombstone'&&!b.assertions.length))throw invalid('Supply 1 to 25 assertions, or no assertions for an explicit tombstone.');
 if(observationKind==='tombstone'&&b.assertions.length)throw invalid('Tombstones must not introduce new assertions.');
 const allowed=ALL_SOURCE_PROFILES.find(p=>p.id===profile)!.allowedProperties as readonly string[];
 const seen=new Set<string>();
 const assertions=b.assertions.map((raw,i):TypedSourceAssertion=>{
  const a=strictBody(raw,['subjectReference','property','value','sourceLocator','assurance']),subjectReference=reference(a.subjectReference,namespace),property=oneOf(a.property,schema===TYPED_SOURCE_SCHEMA?SOURCE_PROPERTIES:SOURCE_PROPERTIES_V2,'assertion property');
  if(!keys.has(sourceReferenceKey(subjectReference)))throw invalid('Every assertion subject must be an explicit reference in the same row.');
  if(!allowed.includes(property))throw invalid(`The property ${property} is not supported by ${profile}.`);
  const assertionKey=sourceReferenceKey(subjectReference)+':'+property;if(seen.has(assertionKey))throw invalid('A row cannot report two values for the same subject and property.');seen.add(assertionKey);
  const value=(SOURCE_QUANTITY_PROPERTIES as readonly string[]).includes(property)?quantity(a.value):text(a.value,'assertion value',2000);
  if(property==='expectedHandoffAt'&&stamp(value,'expectedHandoffAt')===null)throw invalid('An expected handoff deadline requires its declared explicit-offset planned time.');
  if(a.assurance!==undefined&&a.assurance!=='source_reported')throw invalid('Imported assertions are source_reported; physical verification cannot be claimed.');
  let sourceLocator:TypedSourceLocator={row:rowNumber,field:`assertions[${i}].value`,jsonPointer:`/${index}/assertions/${i}/value`};
  if(transport==='text/csv'){
   const loc=strictBody(a.sourceLocator,['row','field']);
   if(loc.row!==rowNumber)throw invalid('The CSV assertion locator must identify its actual original row.');
   sourceLocator={row:rowNumber,field:text(loc.field,'source field',200)};
  }
  // For JSON the locator is always derived from its actual byte-parsed original,
  // never copied from a caller-provided claim of provenance.
  return {subjectReference,property,value,sourceLocator,assurance:'source_reported'};
 });
 for(const line of references.filter(r=>r.type==='order_line'))if(!references.some(r=>r.type==='order'&&r.namespace===line.namespace&&r.externalId===line.parentExternalId))throw invalid('The line parentExternalId must identify its explicitly supplied parent order.');
 if(profile==='packproof.order-lines/v1'&&observationKind!=='tombstone'&&!assertions.some(a=>(SOURCE_QUANTITY_PROPERTIES as readonly string[]).includes(a.property)&&a.subjectReference.type==='order_line'))throw invalid('Order line profiles require an explicit line quantity and unit.');
 if(profile==='packproof.shipment-handling-units/v1'&&observationKind!=='tombstone'&&!assertions.some(a=>a.property==='allocatedQuantity'&&a.subjectReference.type==='order_line'))throw invalid('Shipment line profiles require an explicit allocated line quantity and unit.');
 if(!Array.isArray(b.relationships)||b.relationships.length>TYPED_SOURCE_LIMITS.relationshipsPerRow)throw invalid('Supply an explicit relationship array of at most 30 entries.');
 if(observationKind==='tombstone'&&b.relationships.length)throw invalid('Tombstones must not introduce new relationships.');
 const relationshipKeys=new Set<string>();
 const relationships=b.relationships.map((raw):TypedSourceRelationship=>{
  const r=strictBody(raw,['from','to','type','quantity']),from=reference(r.from,namespace),to=reference(r.to,namespace),type=oneOf(r.type,SOURCE_RELATIONSHIP_TYPES,'relationship type');
  if(!keys.has(sourceReferenceKey(from))||!keys.has(sourceReferenceKey(to)))throw invalid('Relationship endpoints must be explicit references in the same source row.');
  if(type==='has_line'&&(from.type!=='order'||to.type!=='order_line'||to.parentExternalId!==from.externalId))throw invalid('has_line must connect the reported parent order to its own scoped line.');
  if(sourceReferenceKey(from)===sourceReferenceKey(to))throw invalid('A source relationship cannot connect an entity to itself.');
  const result={from,to,type,quantity:r.quantity==null?null:quantity(r.quantity)},key=canonicalize({from,to,type});if(relationshipKeys.has(key))throw invalid('Duplicate relationships are not permitted in a row.');relationshipKeys.add(key);return result;
 });
 for(const line of references.filter(r=>r.type==='order_line'))if(observationKind!=='tombstone'&&profile==='packproof.order-lines/v1'&&!relationships.some(r=>r.type==='has_line'&&r.from.type==='order'&&sourceReferenceKey(r.to)===sourceReferenceKey(line)))throw invalid('An order line requires its explicit parent order relationship; SKU is not a line identity.');
 if(observationKind!=='tombstone'&&profile==='packproof.shipment-handling-units/v1'&&!relationships.some(r=>r.type==='fulfills'&&r.from.type==='shipment'&&r.to.type==='order_line'))throw invalid('A shipment allocation requires its explicit shipment-to-line relationship.');
 if(profile==='packproof.operational-observations/v2')for(const assertion of assertions){
  const tracking=['labelStatus','carrierCode','carrierAccountReference','carrierService','carrierAcceptanceStatus'].includes(assertion.property);
  const handling=['expectedHandoffStatus','loadingHandoffStatus','receiptHandoffStatus','expectedHandoffAt'].includes(assertion.property);
  if(tracking&&(assertion.subjectReference.type!=='tracking'||!relationships.some(r=>r.type==='tracks'&&sourceReferenceKey(r.from)===sourceReferenceKey(assertion.subjectReference)&&r.to.type==='shipment')))throw invalid('Label and carrier assertions require an explicit tracking subject linked to its shipment.');
  if(handling){
   if(assertion.subjectReference.type!=='handling_unit'||!references.some(r=>r.type==='shipment')||!references.some(r=>r.type==='load')||!references.some(r=>r.type==='stop'))throw invalid('A handling-unit handoff assertion requires its explicit unit, shipment, load and delivery stop.');
   const subject=sourceReferenceKey(assertion.subjectReference);
   const direct=relationships.some(r=>r.type==='contains'&&r.from.type==='shipment'&&sourceReferenceKey(r.to)===subject);
   const allocated=relationships.some(r=>r.type==='allocated_to'&&r.from.type==='order_line'&&sourceReferenceKey(r.to)===subject&&relationships.some(s=>s.type==='fulfills'&&s.from.type==='shipment'&&sourceReferenceKey(s.to)===sourceReferenceKey(r.from)));
   if(!direct&&!allocated)throw invalid('A handoff unit must have an explicit shipment membership or shipment-line allocation.');
   if(!relationships.some(r=>r.type==='loaded_on'&&sourceReferenceKey(r.from)===subject&&r.to.type==='load')||!relationships.some(r=>r.type==='delivered_at'&&r.from.type==='shipment'&&r.to.type==='stop'))throw invalid('A handoff assertion requires the reported unit-load and shipment-stop relationships.');
  }
 }
 return {sourceEventId,sourceRevision,observationKind,occurredAt,sourceAsOf,timeQuality,references,assertions,relationships,supersedes,originSystem:optionalText(b.originSystem,'originSystem'),copiedFromSource:optionalText(b.copiedFromSource,'copiedFromSource')};
}

const csvReferenceFields=TYPED_SOURCE_RULES.csvReferenceFields as Partial<Record<SourceCsvFieldV2,SourceEntityType>>;
function csvObservation(raw:Record<string,string>,mapping:TypedSourceBatch['mapping'],constants:TypedSourceBatch['constants'],namespace:string,rowNumber:number,schema:TypedSourceSchema,identityPolicy?:SourceIdentityPolicy):unknown {
 const get=(field:SourceCsvFieldV2)=>mapping[field]===undefined?constants[field as keyof typeof constants]??null:raw[mapping[field]!]||null;
 const kind=get('observationKind');
 let sourceEventId=get('sourceEventId'),sourceRevision=get('sourceRevision'),supersedesRevision=get('supersedesRevision');
 if(schema===TYPED_SOURCE_SCHEMA_V2){
  const policy=identityPolicy!;
  if(policy.eventKey.kind==='composite'){
   if(kind==='event'&&!policy.eventKey.fields.some(f=>f==='sourceEventId'||f==='sourceSequence'))throw invalid('Event composite identity requires an actual event identifier or source sequence; a clock cannot identify an event.');
   const property=get('property');
   if(['labelStatus','carrierCode','carrierAccountReference','carrierService','carrierAcceptanceStatus'].includes(property??'')&&!policy.eventKey.fields.includes('trackingId'))throw invalid('A tracking observation requires its trackingId composite component.');
   if(['expectedHandoffStatus','loadingHandoffStatus','receiptHandoffStatus','expectedHandoffAt'].includes(property??'')&&!policy.eventKey.fields.includes('handlingUnitId'))throw invalid('A handling-unit observation requires its handlingUnitId composite component.');
   sourceEventId=compositeSourceEventId(policy.eventKey.fields,f=>get(f));
  }
  if(policy.revision.kind==='source_as_of'){
   if(kind==='event')throw invalid('An event cannot use a snapshot revision boundary.');
   const at=stamp(get('sourceAsOf'),'sourceAsOf');if(at===null)throw invalid('A snapshot revision requires its actual sourceAsOf boundary.');
   sourceRevision='snapshot:'+new Date(at).toISOString();
   if(supersedesRevision){const old=stamp(supersedesRevision,'supersedesRevision');supersedesRevision='snapshot:'+new Date(old!).toISOString();}
  }else if(policy.revision.kind==='immutable_event'){
   if(kind!=='event'||supersedesRevision!==null)throw invalid('The immutable-event contract cannot reinterpret snapshots or manufacture corrections.');
   sourceRevision=IMMUTABLE_EVENT_REVISION;
  }
 }
 const references:TypedSourceReference[]=[];
 for(const [field,type]of Object.entries(csvReferenceFields)){const id=get(field as SourceCsvFieldV2);if(id)references.push({namespace,type:type!,externalId:id,...(type==='order_line'&&get('orderId')?{parentExternalId:get('orderId')!}:{})});}
 const ref=(type:SourceEntityType)=>references.find(r=>r.type===type),relationships:TypedSourceRelationship[]=[];
 const relate=(from:SourceEntityType,to:SourceEntityType,type:SourceRelationshipType)=>{const a=ref(from),b=ref(to);if(a&&b)relationships.push({from:a,to:b,type,quantity:null});};
 relate('order','order_line','has_line');relate('shipment','order_line','fulfills');relate('order_line','handling_unit','allocated_to');
 relate(ref('handling_unit')?'handling_unit':'shipment','load','loaded_on');relate('shipment','stop','delivered_at');relate('return','order_line','return_of');relate('tracking','shipment','tracks');
 const property=get('property'),isQuantity=(SOURCE_QUANTITY_PROPERTIES as readonly unknown[]).includes(property);
 if(schema===TYPED_SOURCE_SCHEMA_V2&&!ref('order_line'))relate('shipment','handling_unit','contains');
 const tracking=schema===TYPED_SOURCE_SCHEMA_V2&&['labelStatus','carrierCode','carrierAccountReference','carrierService','carrierAcceptanceStatus'].includes(property??'');
 const handling=schema===TYPED_SOURCE_SCHEMA_V2&&['expectedHandoffStatus','loadingHandoffStatus','receiptHandoffStatus','expectedHandoffAt'].includes(property??'');
 const subject=tracking?ref('tracking'):handling?ref('handling_unit'):ref('order_line')??ref('shipment')??ref('handling_unit')??ref('return')??ref('order');
 const amount=get('amount'),unit=get('unit');
 const value=isQuantity?{amount,unit}:get('value');
 if(property==='allocatedQuantity'&&isQuantity&&amount&&unit)for(const r of relationships)if(r.type==='fulfills'||r.type==='allocated_to')r.quantity={amount,unit};
 return {sourceEventId,sourceRevision,observationKind:kind,occurredAt:get('occurredAt'),sourceAsOf:get('sourceAsOf'),timeQuality:get('timeQuality'),references,
 assertions:get('observationKind')==='tombstone'?[]:[{subjectReference:subject,property,value,sourceLocator:{row:rowNumber,field:mapping[isQuantity?'amount':'value']??'declared property'},assurance:'source_reported'}],relationships:get('observationKind')==='tombstone'?[]:relationships,
 supersedes:supersedesRevision?{sourceEventId,sourceRevision:supersedesRevision}:null,originSystem:get('originSystem'),copiedFromSource:get('copiedFromSource')};
}
function rowResult(raw:unknown,candidate:unknown,index:number,rowNumber:number,namespace:string,profile:SourceProfileId,transport:TypedSourceBatch['original']['mediaType'],schema:TypedSourceSchema):TypedSourceRow {
 try {const normalized=parseObservation(candidate,rowNumber,index,namespace,profile,transport,schema);return {index,rowNumber,raw,normalized,errors:[],payloadSha256:sha256Hex(canonicalSourceObservation(normalized))};}
 catch(error){if(!(error instanceof DomainError))throw error;return {index,rowNumber,raw,normalized:null,errors:[error.message],payloadSha256:null};}
}
/** Parse every bounded original row. Clients cannot supply normalized rows or
 * authoritative row locators separately from the preserved original. Malformed
 * business rows remain explicit outcomes; invalid envelopes reject the batch. */
export function parseTypedSourceBatch(input:unknown):TypedSourceBatch {
 const requested=input&&typeof input==='object'&&!Array.isArray(input)?(input as Record<string,unknown>).schema:null;
 const v2=requested===TYPED_SOURCE_SCHEMA_V2;
 const b=strictBody(input,['schema','connectionId','locationId','sourceProfile','mappingVersion','sourceNamespace','subscriptionId','configurationRevision','grantRevision','wholeFileConsent','original','mapping','constants','completeness',...(v2?['identityPolicy']:[])]);
 if(b.schema!==TYPED_SOURCE_SCHEMA&&!v2)throw invalid('Use a supported explicitly versioned typed-source-batch schema.');
 const schema=b.schema as TypedSourceSchema,identityPolicy=v2?parseSourceIdentityPolicy(b.identityPolicy):undefined;
 if(b.wholeFileConsent!==true)throw new DomainError('WHOLE_FILE_CONSENT_REQUIRED','Approve preservation of the complete original, including unmapped columns and other rows.',400);
 const connectionId=text(b.connectionId,'connectionId'),locationId=text(b.locationId,'locationId'),sourceProfile=oneOf(b.sourceProfile,sourceProfilesForSchema(schema).map(p=>p.id),'sourceProfile'),mappingVersion=text(b.mappingVersion,'mappingVersion'),sourceNamespace=text(b.sourceNamespace,'sourceNamespace');
 if(v2&&(Buffer.byteLength(sourceNamespace,'utf8')>200||Buffer.byteLength(locationId,'utf8')>200))throw invalid('Version two source namespace and site identity are bounded to 200 UTF-8 bytes each.');
 const subscriptionId=optionalText(b.subscriptionId,'subscriptionId');
 if(b.configurationRevision!=null&&(!Number.isSafeInteger(b.configurationRevision)||Number(b.configurationRevision)<1))throw invalid('configurationRevision must be a positive approved revision.');
 const configurationRevision=b.configurationRevision==null?null:Number(b.configurationRevision);
 if((subscriptionId===null)!==(configurationRevision===null))throw invalid('subscriptionId and configurationRevision must be supplied together.');
 if(b.grantRevision!=null&&(!Number.isSafeInteger(b.grantRevision)||Number(b.grantRevision)<1))throw invalid('grantRevision must be a positive approved authority revision.');
 const grantRevision=b.grantRevision==null?null:Number(b.grantRevision);
 if((subscriptionId===null)!==(grantRevision===null))throw invalid('An approved subscription and its exact grantRevision must be supplied together.');
 const o=strictBody(b.original,['name','mediaType','content','sha256']),name=text(o.name,'original.name',255),mediaType=oneOf(o.mediaType,['text/csv','application/json'] as const,'original.mediaType');
 if(typeof o.content!=='string'||!o.content.length||Buffer.from(o.content,'utf8').toString('utf8')!==o.content)throw invalid('The original must contain exact nonempty UTF-8 text.');
 if(Buffer.byteLength(o.content,'utf8')>TYPED_SOURCE_LIMITS.bytes)throw new DomainError('TYPED_SOURCE_TOO_LARGE','The qualified inline path accepts originals up to 2 MiB; larger originals need a separately qualified streaming path.',413);
 if(typeof o.sha256!=='string'||!/^[a-f0-9]{64}$/.test(o.sha256)||sha256Hex(o.content)!==o.sha256)throw new DomainError('ORIGINAL_DIGEST_MISMATCH','The declared original digest does not match its exact UTF-8 bytes.',409);
 const original={name,mediaType,content:o.content,sha256:o.sha256};
 const mapping:TypedSourceBatch['mapping']={},constants:TypedSourceBatch['constants']={};
 if(b.mapping!=null){const m=strictBody(b.mapping,[...sourceCsvFieldsForSchema(schema)]);for(const [field,heading]of Object.entries(m))mapping[field as SourceCsvFieldV2]=text(heading,`mapping.${field}`,200);}
 if(b.constants!=null){const c=strictBody(b.constants,['observationKind','property','timeQuality']);for(const [field,value]of Object.entries(c)){if(mapping[field as SourceCsvFieldV2])throw invalid('A field cannot have both a mapped column and a declared constant.');constants[field as keyof typeof constants]=text(value,`constants.${field}`,100);}}
 const c=b.completeness==null?{}:strictBody(b.completeness,['kind','asOf','marker']),completeness:TypedSourceCompleteness={kind:oneOf(c.kind??'unknown',['unknown','snapshot','sequence'] as const,'completeness.kind'),asOf:stamp(c.asOf,'completeness.asOf'),marker:optionalText(c.marker,'completeness.marker',200)};
 if(completeness.kind==='unknown'&&(completeness.asOf||completeness.marker))throw invalid('Unknown completeness cannot supply a completeness marker.');
 if(completeness.kind!=='unknown'&&(!completeness.asOf||!completeness.marker))throw invalid('A claimed source boundary requires both an as-of timestamp and an explicit snapshot/sequence marker.');
 let rows:TypedSourceRow[],headers:string[]=[];
 if(mediaType==='application/json'){
  if(Object.keys(mapping).length||Object.keys(constants).length)throw invalid('JSON observations carry explicit fields; CSV mappings and constants do not apply.');
  if(identityPolicy&&(identityPolicy.eventKey.kind!=='column'||identityPolicy.revision.kind!=='column'))throw invalid('JSON observations require their explicit source IDs and revisions; composite extraction policies apply to mapped CSV originals.');
  let raw:unknown;try {raw=JSON.parse(original.content);}catch{throw invalid('The original JSON is malformed.');}
  if(!Array.isArray(raw)||!raw.length||raw.length>TYPED_SOURCE_LIMITS.rows)throw invalid('The original JSON must contain 1 to 1,000 observation rows.');
  rows=raw.map((item,index)=>rowResult(item,item,index,index+1,sourceNamespace,sourceProfile,mediaType,schema));
 }else{
  const source=original.content.replace(/^\uFEFF/,'');
  const candidates=([',',';','\t'] as const).map(delimiter=>{try{const records=parseCsv(source,delimiter);return {records,score:records[0]?.length??0};}catch(error){return {records:null,score:-1,error};}}).sort((a,b)=>b.score-a.score);
  if(!candidates[0].records)throw candidates[0].error;
  const records=candidates[0].records!;if(records.length<2)throw invalid('Include a header and at least one source row.');
  headers=records[0];if(headers.some(h=>!h.trim()||h.length>200)||new Set(headers).size!==headers.length)throw invalid('Every source heading must be nonempty and unique.');
  const used=new Set<string>();for(const heading of Object.values(mapping)){if(!headers.includes(heading!))throw invalid('Every mapping must name an exact original heading.');if(used.has(heading!))throw invalid('One original column cannot be mapped to two semantic fields.');used.add(heading!);}
  if(identityPolicy)validateSourceIdentityMapping(identityPolicy,mapping,constants,sourceProfile);
  else for(const required of ['sourceEventId','sourceRevision'] as const)if(!mapping[required])throw invalid(`An explicit ${required} column is required; file hashes cannot replace stable business identities.`);
  for(const required of ['observationKind','property','timeQuality'] as const)if(!mapping[required]&&!constants[required])throw invalid(`Declare ${required} as a mapped column or approved source constant.`);
  rows=records.slice(1).map((cells,index)=>{
   const raw=Object.fromEntries(headers.map((h,i)=>[h,cells[i]??'']));
   if(cells.length!==headers.length)return {index,rowNumber:index+2,raw,normalized:null,errors:['The original row has a different number of columns than its header.'],payloadSha256:null};
   try{return rowResult(raw,csvObservation(raw,mapping,constants,sourceNamespace,index+2,schema,identityPolicy),index,index+2,sourceNamespace,sourceProfile,mediaType,schema);}
   catch(error){if(!(error instanceof DomainError))throw error;return {index,rowNumber:index+2,raw,normalized:null,errors:[error.message],payloadSha256:null};}
  });
 }
 if(identityPolicy)for(const row of rows)if(row.normalized){
  const json=mediaType==='application/json',raw=row.raw as Record<string,string>;
  const locator=(field:string):TypedSourceLocator|null=>json?{row:row.rowNumber,field,jsonPointer:`/${row.index}/${field}`}:mapping[field as SourceCsvFieldV2]?{row:row.rowNumber,field:mapping[field as SourceCsvFieldV2]!}:null;
  const get=(field:string):string=>json?String(raw[field]):mapping[field as SourceCsvFieldV2]?raw[mapping[field as SourceCsvFieldV2]!]!:constants[field as keyof typeof constants]!;
  const components=identityPolicy.eventKey.kind==='composite'?identityPolicy.eventKey.fields:['sourceEventId'];
  const revisionField=identityPolicy.revision.kind==='column'?'sourceRevision':identityPolicy.revision.kind==='source_as_of'?'sourceAsOf':null;
  row.normalized.identityDerivation={schema:'packproof.source-identity-derivation/v1',eventKey:{kind:identityPolicy.eventKey.kind,components:components.map(field=>({field,value:get(field),sourceLocator:locator(field),approvedConstant:!json&&!mapping[field as SourceCsvFieldV2]}))},revision:{kind:identityPolicy.revision.kind,sourceValue:revisionField?get(revisionField):null,sourceLocator:revisionField?locator(revisionField):null}};
  row.payloadSha256=sha256Hex(canonicalSourceObservation(row.normalized));
 }
 return {schema,connectionId,locationId,sourceProfile,mappingVersion,sourceNamespace,subscriptionId,configurationRevision,grantRevision,wholeFileConsent:true,original,mapping,constants,completeness,headers,...(identityPolicy?{identityPolicy}:{}),rows};
}
