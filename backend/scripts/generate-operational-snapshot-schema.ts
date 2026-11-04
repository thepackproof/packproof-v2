/** Publish structural JSON Schema; semantic cross-reference checks remain in both independent validators. */
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {SNAPSHOT_SECTION_FIELDS,OPERATIONAL_MANIFEST_PROFILE} from '../src/records/operational-snapshot-profile.js';
type Schema=Record<string,unknown>;
const id:Schema={type:'string',pattern:'^[A-Za-z0-9_-]{1,160}$'},digest:Schema={type:'string',pattern:'^[a-f0-9]{64}$'},instant:Schema={type:'string',format:'date-time',pattern:'^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$'},text:Schema={type:'string',maxLength:2000};
const nullable=(schema:Schema)=>({anyOf:[schema,{type:'null'}]});
const exact=(properties:Record<string,Schema>):Schema=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
function column(field:string):Schema{
  if(field==='created_at')return instant;if(field==='due_at')return nullable(instant);
  if(['parent_id','supersedes_id','external_reference'].includes(field))return nullable(field==='external_reference'?text:id);
  if(field==='sequence')return {type:'string',pattern:'^[1-9][0-9]*$'};
  if(field==='grace_period_ms')return {type:'integer',minimum:0,maximum:2592000000};
  if(['accepted_evidence_types','matching_artifact_ids'].includes(field))return {type:'array',maxItems:field==='accepted_evidence_types'?100:4000,items:field==='matching_artifact_ids'?id:{type:'string',minLength:1,maxLength:200}};
  if(['attributes','assertion','compared_sources'].includes(field))return {};
  if(field==='evaluation_status')return {enum:['satisfied','missing','not_yet_due','waived']};
  if(field==='severity')return {enum:['info','warning','critical']};
  if(field==='action')return {enum:['acknowledge','resolve','reopen','note']};
  if(field==='kind')return {enum:['shipment','stop','package','pallet','item','return']};
  return field==='id'||field.endsWith('_id')?id:text;
}
const sectionProperties=Object.fromEntries(Object.entries(SNAPSHOT_SECTION_FIELDS).map(([name,fields])=>[name,{type:'array',maxItems:10000,items:exact(Object.fromEntries(fields.map(field=>[field,column(field)])))}]));
const artifact=exact({artifactId:id,path:{type:'string',pattern:'^originals/[A-Za-z0-9_-]{1,160}$'},kind:{enum:['CAPTURE_ORIGINAL','SOURCE_ARTIFACT']},evidenceType:{type:'string',minLength:1,maxLength:200},sha256:digest,byteSize:{type:'integer',minimum:0,maximum:200*1024*1024},contentType:{type:'string',maxLength:200},storage:exact({bucket:{type:'string',minLength:1,maxLength:63},key:{type:'string',minLength:1,maxLength:1024},versionId:{type:'string',minLength:1,maxLength:1024,not:{const:'null'}}}),source:exact({kind:{type:'string',minLength:1,maxLength:200},reference:nullable(text),reportedAt:nullable(instant),receivedAt:instant,acceptedAt:instant,actorId:nullable(id),connectionId:nullable(id),receiptSha256:nullable(digest)}),derivation:nullable(exact({sourceArtifactId:id,recipeSha256:digest}))});
const schema={$schema:'https://json-schema.org/draft/2020-12/schema',$id:'https://schemas.thepackproof.com/operational/v1/manifest.schema.json',title:'Organization-submitted operational record manifest v1',description:'Structural schema. Canonical bytes, digest/tenant/core/prior linkage, membership, evaluation and cycle constraints must also pass the independent profile validators.',...exact({profile:{const:OPERATIONAL_MANIFEST_PROFILE},assertion:{const:'ORGANIZATION_SUBMITTED'},snapshotId:id,organizationId:id,environment:{enum:['sandbox','live']},proofId:id,revision:{type:'integer',minimum:1},priorSnapshot:nullable(exact({snapshotId:id,manifestSha256:digest})),core:exact({manifestSha256:digest}),evaluation:exact({at:instant,version:{const:'packproof.requirement-evaluation.v1'}}),actor:exact({userId:id,membershipId:id,role:{enum:['OWNER','ADMIN']},locationId:nullable(id)}),record:exact({title:nullable(text),reference:nullable(text),lifecycle:{enum:['open','closed']},reviewState:{enum:['unreviewed','reviewed']},locationId:nullable(id),updatedAt:instant}),...sectionProperties,artifacts:{type:'array',maxItems:4000,items:artifact},omissions:{type:'array',maxItems:10000,items:exact({artifactId:id,reason:{enum:['MISSING','QUARANTINED','WITHHELD','UNAVAILABLE','PENDING']},detail:{type:'string',minLength:1,maxLength:2000}})}})};
writeFileSync(fileURLToPath(new URL('../../packages/evidence-contracts/schemas/operational-snapshot-manifest.v1.schema.json',import.meta.url)),`${JSON.stringify(schema,null,2)}\n`);
