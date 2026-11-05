/** New signing domain. Never reserialize or reinterpret historical core manifests. */
import { createHash, createPublicKey } from 'node:crypto';
import { base64url, flattenedVerify, importSPKI } from 'jose';
import { fromBER } from 'asn1js';
import { createECDSASignatureFromCMS } from 'pkijs';
import { jcsBytes, sha256, type ExactObject, type EnvelopeJws } from '../integrity/envelope-profile.js';
import type { KmsSigningTransport } from '../integrity/kms-signing-runtime.js';

export const OPERATIONAL_MANIFEST_PROFILE = 'packproof.operational-record-manifest.v1' as const;
export const OPERATIONAL_SNAPSHOT_PROFILE = 'packproof.operational-snapshot.v1' as const;
export const OPERATIONAL_SNAPSHOT_TYPE = 'application/packproof-operational-snapshot+jws' as const;
export const OPERATIONAL_EVALUATION_PROFILE = 'packproof.requirement-evaluation.v1' as const;
export const OPERATIONAL_MAX_METADATA = 8 * 1024 * 1024;
export type SnapshotRow = Record<string, any>;
export interface OperationalArtifact {
  artifactId:string; path:string; kind:'CAPTURE_ORIGINAL'|'SOURCE_ARTIFACT'; evidenceType:string;
  sha256:string; byteSize:number; contentType:string; storage:ExactObject;
  source:{kind:string;reference:string|null;reportedAt:string|null;receivedAt:string;acceptedAt:string;actorId:string|null;connectionId:string|null;receiptSha256:string|null};
  derivation:null|{sourceArtifactId:string;recipeSha256:string};
}
export interface OperationalManifest {
  profile:typeof OPERATIONAL_MANIFEST_PROFILE; assertion:'ORGANIZATION_SUBMITTED';
  snapshotId:string; organizationId:string; environment:'live'|'sandbox'; proofId:string; revision:number;
  priorSnapshot:null|{snapshotId:string;manifestSha256:string}; core:{manifestSha256:string|null};
  evaluation:{at:string;version:typeof OPERATIONAL_EVALUATION_PROFILE};
  actor:{userId:string;membershipId:string;role:'OWNER'|'ADMIN';locationId:string|null};
  record:{title:string|null;reference:string|null;lifecycle:'open'|'closed';reviewState:'unreviewed'|'reviewed';locationId:string|null;updatedAt:string};
  entities:SnapshotRow[]; links:SnapshotRow[]; requirements:SnapshotRow[]; waivers:SnapshotRow[];
  issues:SnapshotRow[]; actions:SnapshotRow[]; amendments:SnapshotRow[];
  artifacts:OperationalArtifact[];
  omissions:Array<{artifactId:string;reason:'MISSING'|'QUARANTINED'|'WITHHELD'|'UNAVAILABLE'|'PENDING';detail:string}>;
}
export interface OperationalEnvelope {
  profile:typeof OPERATIONAL_SNAPSHOT_PROFILE; snapshotId:string; organizationId:string; environment:'live'|'sandbox';
  proofId:string;revision:number;manifestPath:'operational/manifest.json';manifestSha256:string;issuer:string;issuedAt:string;
}
export const SNAPSHOT_SECTION_FIELDS = {
  entities:['id','proof_id','kind','external_reference','parent_id','attributes','actor_user_id','supersedes_id','created_at'],
  links:['id','proof_id','evidence_id','subject_id','reason','actor_user_id','created_at'],
  requirements:['id','proof_id','subject_id','stage','title','template_version','accepted_evidence_types','due_at','grace_period_ms','created_at','evaluation_status','matching_artifact_ids'],
  waivers:['id','requirement_id','reason','actor_user_id','created_at'],
  issues:['id','proof_id','category','severity','title','subject_id','rule_version','compared_sources','created_at'],
  actions:['id','sequence','issue_id','action','reason','actor_user_id','created_at'],
  amendments:['id','proof_id','supersedes_id','assertion','reason','actor_user_id','created_at'],
} as const;
export function snapshotCheck(ok:unknown,code:string):asserts ok { if(!ok)throw Error(`OPERATIONAL_SNAPSHOT_${code}`); }
export const snapshotId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(v);
const digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const text=(v:unknown,max=2000)=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff]/u.test(v);
const instant=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
export function snapshotExact(v:unknown,fields:readonly string[]):asserts v is SnapshotRow {
  snapshotCheck(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...fields].sort().join(','),'FIELDS_INVALID');
}
function nullableId(v:unknown){return v===null||snapshotId(v);}
function neutralJson(v:unknown,depth=0):boolean {
  if(depth>12)return false;
  if(v===null||typeof v==='boolean'||typeof v==='string')return typeof v!=='string'||text(v,20000);
  if(typeof v==='number')return Number.isFinite(v)&&Math.abs(v)<=Number.MAX_SAFE_INTEGER;
  if(Array.isArray(v))return v.length<=10000&&v.every(x=>neutralJson(x,depth+1));
  return !!v&&typeof v==='object'&&Object.keys(v).length<=1000&&Object.entries(v).every(([k,x])=>text(k,200)&&neutralJson(x,depth+1));
}
export function evaluateSnapshotRequirements(manifest:Pick<OperationalManifest,'proofId'|'evaluation'|'requirements'|'waivers'|'links'|'artifacts'>):void {
  for(const r of manifest.requirements){
    const deadline=r.due_at===null?null:Date.parse(r.due_at)+r.grace_period_ms;
    const matching=manifest.artifacts.filter(a=>r.accepted_evidence_types.includes(a.evidenceType)&&(deadline===null||Date.parse(a.source.acceptedAt)<=deadline)&&
      ((a.kind==='CAPTURE_ORIGINAL'&&r.subject_id===manifest.proofId)||manifest.links.some(l=>l.evidence_id===a.artifactId&&l.subject_id===r.subject_id))).map(a=>a.artifactId).sort();
    r.matching_artifact_ids=matching;
    r.evaluation_status=manifest.waivers.some(w=>w.requirement_id===r.id)?'waived':matching.length?'satisfied':deadline===null||deadline>Date.parse(manifest.evaluation.at)?'not_yet_due':'missing';
  }
}
export function validateOperationalManifest(value:unknown):asserts value is OperationalManifest {
  snapshotExact(value,['profile','assertion','snapshotId','organizationId','environment','proofId','revision','priorSnapshot','core','evaluation','actor','record',...Object.keys(SNAPSHOT_SECTION_FIELDS),'artifacts','omissions']);
  snapshotCheck(value.profile===OPERATIONAL_MANIFEST_PROFILE&&value.assertion==='ORGANIZATION_SUBMITTED'&&['live','sandbox'].includes(value.environment)&&['snapshotId','organizationId','proofId'].every(k=>snapshotId(value[k]))&&Number.isSafeInteger(value.revision)&&value.revision>0,'IDENTITY_INVALID');
  snapshotExact(value.core,['manifestSha256']);snapshotCheck(value.core.manifestSha256===null||digest(value.core.manifestSha256),'CORE_INVALID');
  if(value.priorSnapshot!==null){snapshotExact(value.priorSnapshot,['snapshotId','manifestSha256']);snapshotCheck(snapshotId(value.priorSnapshot.snapshotId)&&value.priorSnapshot.snapshotId!==value.snapshotId&&digest(value.priorSnapshot.manifestSha256),'PRIOR_INVALID');}
  snapshotExact(value.evaluation,['at','version']);snapshotCheck(instant(value.evaluation.at)&&value.evaluation.version===OPERATIONAL_EVALUATION_PROFILE,'EVALUATION_INVALID');
  snapshotExact(value.actor,['userId','membershipId','role','locationId']);snapshotCheck(snapshotId(value.actor.userId)&&snapshotId(value.actor.membershipId)&&['OWNER','ADMIN'].includes(value.actor.role)&&nullableId(value.actor.locationId),'ACTOR_INVALID');
  snapshotExact(value.record,['title','reference','lifecycle','reviewState','locationId','updatedAt']);snapshotCheck((value.record.title===null||text(value.record.title))&&(value.record.reference===null||text(value.record.reference))&&['open','closed'].includes(value.record.lifecycle)&&['reviewed','unreviewed'].includes(value.record.reviewState)&&nullableId(value.record.locationId)&&value.actor.locationId===value.record.locationId&&instant(value.record.updatedAt),'RECORD_INVALID');
  for(const [section,fields] of Object.entries(SNAPSHOT_SECTION_FIELDS)){
    snapshotCheck(Array.isArray(value[section])&&value[section].length<=10000,'SECTION_LIMIT');const ids=new Set();
    for(const row of value[section]){snapshotExact(row,fields);snapshotCheck(snapshotId(row.id)&&!ids.has(row.id)&&(!('proof_id'in row)||row.proof_id===value.proofId)&&instant(row.created_at)&&neutralJson(row),'ROW_INVALID');ids.add(row.id);}
  }
  const m=value as OperationalManifest,entities=new Set([m.proofId,...m.entities.map(e=>e.id)]),artifactIds=new Set<string>();
  snapshotCheck(Array.isArray(m.artifacts)&&m.artifacts.length<=4000&&Array.isArray(m.omissions)&&m.omissions.length<=10000,'MEMBERSHIP_LIMIT');
  snapshotCheck(Date.parse(m.record.updatedAt)<=Date.parse(m.evaluation.at),'FUTURE_RECORD');
  for(const section of Object.keys(SNAPSHOT_SECTION_FIELDS))for(const row of m[section as keyof typeof SNAPSHOT_SECTION_FIELDS])snapshotCheck(Date.parse(row.created_at)<=Date.parse(m.evaluation.at),'FUTURE_ROW');
  let budget=200*1024*1024;
  for(const a of m.artifacts){
    snapshotExact(a,['artifactId','path','kind','evidenceType','sha256','byteSize','contentType','storage','source','derivation']);
    snapshotCheck(snapshotId(a.artifactId)&&!artifactIds.has(a.artifactId)&&a.path===`originals/${a.artifactId}`&&['CAPTURE_ORIGINAL','SOURCE_ARTIFACT'].includes(a.kind)&&text(a.evidenceType,200)&&a.evidenceType.length>0&&digest(a.sha256)&&Number.isSafeInteger(a.byteSize)&&a.byteSize>=0&&a.byteSize<=budget&&text(a.contentType,200),'ARTIFACT_INVALID');budget-=a.byteSize;
    snapshotExact(a.storage,['bucket','key','versionId']);snapshotCheck(text(a.storage.bucket,63)&&a.storage.bucket.length>0&&text(a.storage.key,1024)&&a.storage.key.length>0&&text(a.storage.versionId,1024)&&a.storage.versionId.length>0&&a.storage.versionId!=='null','EXACT_VERSION_REQUIRED');
    snapshotExact(a.source,['kind','reference','reportedAt','receivedAt','acceptedAt','actorId','connectionId','receiptSha256']);snapshotCheck(text(a.source.kind,200)&&a.source.kind.length>0&&(a.source.reference===null||text(a.source.reference,2000))&&(a.source.reportedAt===null||instant(a.source.reportedAt))&&instant(a.source.receivedAt)&&instant(a.source.acceptedAt)&&Date.parse(a.source.receivedAt)<=Date.parse(a.source.acceptedAt)&&Date.parse(a.source.acceptedAt)<=Date.parse(m.evaluation.at)&&nullableId(a.source.actorId)&&nullableId(a.source.connectionId)&&(a.source.receiptSha256===null||digest(a.source.receiptSha256)),'SOURCE_INVALID');
    snapshotCheck(a.kind!=='SOURCE_ARTIFACT'||a.source.actorId!==null&&a.source.receiptSha256!==null,'SOURCE_ATTRIBUTION_REQUIRED');
    if(a.derivation!==null){snapshotExact(a.derivation,['sourceArtifactId','recipeSha256']);snapshotCheck(snapshotId(a.derivation.sourceArtifactId)&&digest(a.derivation.recipeSha256),'DERIVATION_INVALID');}
    artifactIds.add(a.artifactId);
  }
  for(const a of m.artifacts)if(a.derivation)snapshotCheck(artifactIds.has(a.derivation.sourceArtifactId)&&a.derivation.sourceArtifactId!==a.artifactId,'DERIVATION_SOURCE_MISSING');
  function acyclic(items:Array<{id:string;parent:string|null}>){const parents=new Map(items.map(i=>[i.id,i.parent]));for(const i of items){const seen=new Set<string>();let id:string|null=i.id;while(id!==null&&parents.has(id)){snapshotCheck(!seen.has(id),'ANCESTRY_CYCLE');seen.add(id);id=parents.get(id)!;}}}
  acyclic(m.artifacts.map(a=>({id:a.artifactId,parent:a.derivation?.sourceArtifactId??null})));
  for(const o of m.omissions){snapshotExact(o,['artifactId','reason','detail']);snapshotCheck(snapshotId(o.artifactId)&&!artifactIds.has(o.artifactId)&&['MISSING','QUARANTINED','WITHHELD','UNAVAILABLE','PENDING'].includes(o.reason)&&text(o.detail,2000)&&o.detail.length>0,'OMISSION_INVALID');artifactIds.add(o.artifactId);}
  for(const e of m.entities)snapshotCheck(['shipment','stop','package','pallet','item','return'].includes(e.kind)&&nullableId(e.parent_id)&&nullableId(e.supersedes_id)&&(e.parent_id===null||entities.has(e.parent_id))&&(e.supersedes_id===null||entities.has(e.supersedes_id))&&(e.external_reference===null||text(e.external_reference))&&snapshotId(e.actor_user_id),'ENTITY_INVALID');
  acyclic(m.entities.map(e=>({id:e.id,parent:e.parent_id})));acyclic(m.entities.map(e=>({id:e.id,parent:e.supersedes_id})));
  for(const e of m.entities)if(e.supersedes_id)snapshotCheck(m.entities.find(prior=>prior.id===e.supersedes_id)?.kind===e.kind,'SUPERSESSION_KIND_MISMATCH');
  for(const l of m.links)snapshotCheck(artifactIds.has(l.evidence_id)&&entities.has(l.subject_id)&&text(l.reason)&&snapshotId(l.actor_user_id),'LINK_MEMBERSHIP_INVALID');
  const requirements=new Set(m.requirements.map(r=>r.id)),issues=new Set(m.issues.map(i=>i.id)),waived=new Set();
  for(const w of m.waivers){snapshotCheck(requirements.has(w.requirement_id)&&!waived.has(w.requirement_id)&&text(w.reason)&&snapshotId(w.actor_user_id),'WAIVER_INVALID');waived.add(w.requirement_id);}
  for(const r of m.requirements)snapshotCheck(entities.has(r.subject_id)&&text(r.stage)&&text(r.title)&&text(r.template_version)&&Array.isArray(r.accepted_evidence_types)&&r.accepted_evidence_types.length>0&&r.accepted_evidence_types.length<=100&&r.accepted_evidence_types.every((s:unknown)=>text(s,200))&&(r.due_at===null||instant(r.due_at))&&Number.isSafeInteger(r.grace_period_ms)&&r.grace_period_ms>=0&&r.grace_period_ms<=2592000000&&Array.isArray(r.matching_artifact_ids),'REQUIREMENT_INVALID');
  for(const i of m.issues)snapshotCheck(entities.has(i.subject_id)&&['info','warning','critical'].includes(i.severity)&&text(i.category)&&text(i.title)&&text(i.rule_version),'ISSUE_INVALID');
  const sequences=new Set();for(const a of m.actions){snapshotCheck(issues.has(a.issue_id)&&typeof a.sequence==='string'&&/^[1-9]\d*$/.test(a.sequence)&&!sequences.has(a.sequence)&&['acknowledge','resolve','reopen','note'].includes(a.action)&&text(a.reason)&&snapshotId(a.actor_user_id),'ACTION_INVALID');sequences.add(a.sequence);}
  for(const a of m.amendments)snapshotCheck(snapshotId(a.supersedes_id)&&text(a.reason)&&snapshotId(a.actor_user_id),'AMENDMENT_INVALID');
  const recomputed=JSON.parse(JSON.stringify(m)) as OperationalManifest;evaluateSnapshotRequirements(recomputed);
  snapshotCheck(jcsBytes(m.requirements).equals(jcsBytes(recomputed.requirements)),'EVALUATION_MISMATCH');
  snapshotCheck(jcsBytes(m).length<=OPERATIONAL_MAX_METADATA,'MANIFEST_TOO_LARGE');
}
export function validateOperationalEnvelope(v:unknown):asserts v is OperationalEnvelope {
  snapshotExact(v,['profile','snapshotId','organizationId','environment','proofId','revision','manifestPath','manifestSha256','issuer','issuedAt']);
  snapshotCheck(v.profile===OPERATIONAL_SNAPSHOT_PROFILE&&['snapshotId','organizationId','proofId'].every(k=>snapshotId(v[k]))&&['live','sandbox'].includes(v.environment)&&Number.isSafeInteger(v.revision)&&v.revision>0&&v.manifestPath==='operational/manifest.json'&&digest(v.manifestSha256)&&instant(v.issuedAt)&&typeof v.issuer==='string'&&/^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9_./-]*)?$/.test(v.issuer),'ENVELOPE_INVALID');
}
export function operationalEnvelope(manifest:OperationalManifest,issuer:string,issuedAt:string):OperationalEnvelope {
  validateOperationalManifest(manifest);const envelope:OperationalEnvelope={profile:OPERATIONAL_SNAPSHOT_PROFILE,snapshotId:manifest.snapshotId,organizationId:manifest.organizationId,environment:manifest.environment,proofId:manifest.proofId,revision:manifest.revision,manifestPath:'operational/manifest.json',manifestSha256:sha256(jcsBytes(manifest)),issuer,issuedAt};validateOperationalEnvelope(envelope);return envelope;
}
/** Explicit managed-key support for this profile only; caller must first preserve all exact inputs. */
export async function createOperationalSnapshotSigner(input:{keyArn:string;keyId:string;pinnedPublicKeyPem:string;transport:KmsSigningTransport}) {
  snapshotCheck(/^arn:aws(?:-us-gov|-cn)?:kms:[a-z0-9-]+:\d{12}:key\/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$/.test(input.keyArn)&&snapshotId(input.keyId),'EXACT_KMS_KEY_REQUIRED');
  const key=createPublicKey(input.pinnedPublicKeyPem);snapshotCheck(key.asymmetricKeyType==='ec'&&key.asymmetricKeyDetails?.namedCurve==='prime256v1','P256_REQUIRED');
  const remote=await input.transport.getPublicKey({KeyId:input.keyArn});snapshotCheck(remote.KeyId===input.keyArn&&remote.KeySpec==='ECC_NIST_P256'&&remote.KeyUsage==='SIGN_VERIFY'&&remote.SigningAlgorithms?.includes('ECDSA_SHA_256')&&remote.PublicKey&&Buffer.from(remote.PublicKey).equals(key.export({format:'der',type:'spki'})),'KMS_KEY_MISMATCH');
  const joseKey=await importSPKI(input.pinnedPublicKeyPem,'ES256');
  return async(bytes:Uint8Array):Promise<EnvelopeJws>=>{
    snapshotCheck(bytes.byteLength<=16384,'ENVELOPE_LIMIT');const payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));validateOperationalEnvelope(payload);snapshotCheck(jcsBytes(payload).equals(Buffer.from(bytes)),'NONCANONICAL_ENVELOPE');
    const protectedHeader=base64url.encode(jcsBytes({alg:'ES256',kid:input.keyId,typ:OPERATIONAL_SNAPSHOT_TYPE})),encoded=base64url.encode(bytes);
    const response=await input.transport.sign({KeyId:input.keyArn,SigningAlgorithm:'ECDSA_SHA_256',MessageType:'DIGEST',Message:createHash('sha256').update(`${protectedHeader}.${encoded}`,'ascii').digest()});
    snapshotCheck(response.KeyId===input.keyArn&&response.SigningAlgorithm==='ECDSA_SHA_256'&&response.Signature&&response.Signature.byteLength<=80,'KMS_RESPONSE_INVALID');
    const der=Buffer.from(response.Signature!),parsed=fromBER(der);snapshotCheck(parsed.offset===der.length,'DER_INVALID');const signature=new Uint8Array(createECDSASignatureFromCMS(parsed.result,32));snapshotCheck(signature.length===64,'SIGNATURE_WIDTH_INVALID');
    const jws={protected:protectedHeader,payload:encoded,signature:base64url.encode(signature)};const verified=await flattenedVerify(jws,joseKey,{algorithms:['ES256']});snapshotCheck(Buffer.from(verified.payload).equals(Buffer.from(bytes)),'SIGNATURE_MISMATCH');return jws;
  };
}
