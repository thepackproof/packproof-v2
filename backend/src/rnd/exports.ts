import { Readable } from 'node:stream';
import { canonicalize } from '../../../packages/evidence-contracts/contracts.mjs';
import { streamZip,zipBytes,type ZipStreamEntry } from '../export/zip-stream.js';
import { newId } from '../ids.js';
import { sha256Hex } from '../hash.js';
import { authorized,bad,idempotent,onlyKeys,signedRecord } from './security.js';
import { requireRnd } from './config.js';
import type { AnalysisRow,RndDeps } from './types.js';
import { loadProof } from '../domain/proof-access.js';
import { listAnnotations } from './annotations.js';
import { listEnrollments } from './enrollment.js';
import { listCaptureSidecars } from './capture-sidecars.js';

export async function extensions(deps:RndDeps,actor:string,proofId:string,after=0) {
 await authorized(deps.db,proofId,actor);
 if(!deps.rnd?.enabled||deps.rnd.killSwitch)bad('RND_DISABLED','Experimental analysis is disabled',404);
 if(!Number.isSafeInteger(after)||after<0)bad('RND_INVALID_CURSOR','Invalid extension cursor');
 const rows=(await deps.db.query<{canonical_json:string;digest:string;signature:unknown;sequence:number}>('SELECT canonical_json,digest,signature,sequence FROM rnd_extensions WHERE proof_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 100',[proofId,after])).rows;
 for(const row of rows)requireRnd(deps.rnd,JSON.parse(row.canonical_json).analysis.feature,'internalDisplay');
 return {extensions:rows.map(r=>({canonicalJson:r.canonical_json,digest:r.digest,signature:r.signature})),nextCursor:rows.length===100?rows[rows.length-1].sequence:null};
}
export async function researchBundle(deps:RndDeps,actor:string,proofId:string,mode:'METADATA_ONLY'|'ORIGINALS_INCLUDED'='METADATA_ONLY') {
 return deps.db.transaction(async tx=>{await loadProof(tx,proofId,true);return researchBundleSnapshot({...deps,db:tx},actor,proofId,mode);});
}
async function researchBundleSnapshot(deps:RndDeps,actor:string,proofId:string,mode:'METADATA_ONLY'|'ORIGINALS_INCLUDED') {
 await authorized(deps.db,proofId,actor);
 if(!deps.rnd?.enabled||deps.rnd.killSwitch)bad('RND_DISABLED','Experimental analysis is disabled',404);
 const root=(await deps.db.query<Record<string,unknown>>('SELECT canonical_json,sha256,signature_algorithm,signing_key_id,signature_base64,signed_at FROM final_manifests WHERE proof_id=$1',[proofId])).rows[0];
 if(!root)bad('RND_ROOT_NOT_SEALED','Finalize the ordinary Proof before export',409);
 const rows=(await deps.db.query<{canonical_json:string;digest:string;signature:unknown}>('SELECT canonical_json,digest,signature FROM rnd_extensions WHERE proof_id=$1 ORDER BY sequence',[proofId])).rows;
 for(const row of rows)requireRnd(deps.rnd,JSON.parse(row.canonical_json).analysis.feature,'internalDisplay');
 const receipts=(await deps.db.query<{canonical_json:string;digest:string;signature:unknown}>(`SELECT r.canonical_json,r.digest,r.signature FROM rnd_session_receipts r JOIN rnd_intents i ON i.id=r.intent_id WHERE i.proof_id=$1 ORDER BY r.created_at,i.id`,[proofId])).rows;
 const sources=(await deps.db.query<Record<string,unknown>>('SELECT * FROM rnd_sources WHERE proof_id=$1 ORDER BY id',[proofId])).rows;
 const captureIntents=(await deps.db.query<{canonical_json:string;digest:string;signature:unknown}>('SELECT canonical_json,digest,signature FROM rnd_intents WHERE proof_id=$1 ORDER BY created_at,id',[proofId])).rows.map(r=>({canonicalJson:r.canonical_json,digest:r.digest,signature:r.signature}));
 if(captureIntents.length||receipts.length)requireRnd(deps.rnd,'verifiedcapture','internalDisplay');
 const annotations=(await listAnnotations(deps,actor,proofId)).annotations;
 const hasEnrollments=Boolean((await deps.db.query('SELECT 1 FROM rnd_enrollments WHERE proof_id=$1 LIMIT 1',[proofId])).rows[0]);
 const enrollmentRecords=hasEnrollments?(await listEnrollments(deps,actor,proofId)).enrollments:[];
 const artifacts=rows.flatMap(row=>{const analysis=JSON.parse(row.canonical_json).analysis;if(analysis.feature==='proofshield')return [];return (analysis.details.artifacts??[]).map((a:Record<string,unknown>,index:number)=>({...a,archivePath:`artifacts/${analysis.analysisId}/${index}.bin`}));}) as Record<string,unknown>[];
 const exportedAt=deps.clock.now().toISOString();
 const inventory=sources.map(s=>({sourceId:s.id,evidenceId:s.evidence_id,objectKey:s.object_key,objectVersionId:s.object_version_id,sha256:s.sha256,byteLength:Number(s.byte_length),mimeType:s.mime_type,archivePath:`originals/${s.id}.bin`}));
 const hasSidecars=Boolean((await deps.db.query('SELECT 1 FROM rnd_capture_sidecars WHERE proof_id=$1 LIMIT 1',[proofId])).rows[0]);
 const sidecars=hasSidecars?(await listCaptureSidecars(deps,actor,proofId)).map(item=>({...item,archivePath:inventory.find(s=>s.sourceId===item.sidecar.source.sourceId)?.archivePath??`sidecars/${item.sidecar.id}.bin`})):[];
 const omissions=[...(mode==='METADATA_ONLY'?['This metadata export omits original and artifact bytes.']:[]),'Only sources used by included research analyses or capture receipts are packaged; unrelated ordinary Proof evidence is not included.','Unknown or revoked signing keys are not trusted merely because they appear in the bundle.','Unreviewed privacy derivatives are omitted.','No physical, hardware, independent witness, or scientific qualification is implied.'];
 const snapshot={schemaVersion:'packproof.rnd-export-snapshot.v1',proofId,rootDigest:root.sha256,extensionCount:rows.length,extensionHeadDigest:rows.at(-1)?.digest??null,extensionDigests:rows.map(r=>r.digest),captureIntentDigests:captureIntents.map(r=>r.digest),captureReceiptDigests:receipts.map(r=>r.digest),sources:inventory,artifacts,annotations,enrollmentRecords,sidecars,issuedAt:exportedAt,mode,audience:'AUTHORIZED_PROOF_PARTICIPANT',omissions};
 const exportSnapshot=await signedRecord(deps,proofId,newId('rnd_export'),snapshot);
 return {schemaVersion:'packproof.rnd-export.v1',proofId,exportedAt,mode,audience:'AUTHORIZED_PROOF_PARTICIPANT',exportSnapshot,root:{canonicalJson:root.canonical_json,digest:root.sha256,signature:root.signature_base64?{algorithm:root.signature_algorithm,keyId:root.signing_key_id,signatureBase64:root.signature_base64,signedAt:new Date(root.signed_at as string).toISOString()}:null},extensions:rows.map(r=>({canonicalJson:r.canonical_json,digest:r.digest,signature:r.signature})),captureIntents,captureReceipts:receipts.map(r=>({canonicalJson:r.canonical_json,digest:r.digest,signature:r.signature})),sources:inventory,artifacts,annotations,enrollmentRecords,sidecars,trustList:deps.manifestSigning?.trustList??null,omissions};
}
export async function exportResearchZip(deps:RndDeps,actor:string,proofId:string) {
 const bundle=await researchBundle(deps,actor,proofId,'ORIGINALS_INCLUDED');
 return streamZip((async function*(){
  yield zipBytes('bundle.json',Buffer.from(canonicalize(bundle)));
  const sourcePaths=new Set(bundle.sources.map(s=>s.archivePath));
  const extraSidecars=bundle.sidecars.filter(s=>!sourcePaths.has(s.archivePath)).map(s=>({...s.sidecar.source,archivePath:s.archivePath}));
  for(const source of [...bundle.sources,...bundle.artifacts,...extraSidecars]){
   const object=await deps.objectStore.get(source.objectKey as string,{versionId:String(source.objectVersionId).startsWith('content-addressed:')?null:source.objectVersionId as string});
   if(!object||sha256Hex(object.body)!==String(source.sha256).replace(/^sha256:/,'')||object.body.length!==source.byteLength)bad('RND_SOURCE_INTEGRITY','Export cannot reproduce an unavailable or changed original',409);
   yield zipBytes(String(source.archivePath),object.body);
  }
 })(),{maximumBytes:220*1024*1024,beforeChunk:async()=>{await authorized(deps.db,proofId,actor);}});
}
export async function artifactFor(deps:RndDeps,actor:string,proofId:string,analysisId:string,index:number) {
 await authorized(deps.db,proofId,actor);
 const row=(await deps.db.query<AnalysisRow>('SELECT * FROM rnd_analyses WHERE id=$1 AND proof_id=$2 AND operational_state=\'SUCCEEDED\'',[analysisId,proofId])).rows[0];
 if(!row)bad('RND_ARTIFACT_NOT_FOUND','Artifact unavailable',404);
 requireRnd(deps.rnd,row.feature,'internalDisplay');
 const artifacts=(row.result_json?.details as Record<string,unknown>)?.artifacts as Record<string,unknown>[];
 if(!Number.isSafeInteger(index)||index<0||!artifacts?.[index])bad('RND_ARTIFACT_NOT_FOUND','Artifact unavailable',404);
 const artifact=artifacts[index];
 const bytes=await deps.objectStore.get(String(artifact.objectKey),{versionId:String(artifact.objectVersionId).startsWith('content-addressed:')?null:String(artifact.objectVersionId)});
 if(!bytes||sha256Hex(bytes.body)!==String(artifact.sha256).replace(/^sha256:/,''))bad('RND_SOURCE_INTEGRITY','Artifact commitment could not be verified',409);
 return {row,artifact,bytes};
}
export async function reviewDerivative(deps:RndDeps,actor:string,proofId:string,analysisId:string,key:unknown,input:unknown) {
 requireRnd(deps.rnd,'proofshield','internalDisplay');onlyKeys(input,['approved','artifactSha256','recipeSha256']);
 if(typeof input.approved!=='boolean'||!/^([a-f0-9]{64})$/.test(String(input.artifactSha256))||!/^([a-f0-9]{64})$/.test(String(input.recipeSha256)))bad('RND_INVALID_REVIEW','Review must bind the exact derivative and recipe digest');
 return idempotent(deps,proofId,actor,`review:${analysisId}`,key,input,async tx=>{
  const row=(await tx.query<AnalysisRow>('SELECT * FROM rnd_analyses WHERE id=$1 AND proof_id=$2 AND feature=\'proofshield\' AND operational_state=\'SUCCEEDED\'',[analysisId,proofId])).rows[0];
  const details=row?.result_json?.details as {observations?:{record?:Record<string,unknown>}[]}|undefined;
  const record=details?.observations?.[0]?.record;
  if(!record||record.derivativeSha256!==input.artifactSha256||record.recipeSha256!==input.recipeSha256)bad('RND_REVIEW_BINDING','Review does not match this committed derivative',409);
  const id=newId('rnd_review'),review={schemaVersion:'packproof.derivative-review.v1',id,proofId,analysisId,reviewerId:actor,...input,createdAt:deps.clock.now().toISOString()};
  const signed=await signedRecord(deps,proofId,id,review);
  await tx.query('INSERT INTO rnd_derivative_reviews(id,analysis_id,actor_id,artifact_sha256,recipe_sha256,approved,canonical_json,digest,signature,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,analysisId,actor,input.artifactSha256,input.recipeSha256,input.approved,signed.canonicalJson,signed.digest,JSON.stringify(signed.signature),review.createdAt]);
  return {review,...signed};
 });
}
export async function exportDerivativeZip(deps:RndDeps,actor:string,proofId:string,analysisId:string) {
 const {row,artifact,bytes}=await artifactFor(deps,actor,proofId,analysisId,0);
 if(row.feature!=='proofshield')bad('RND_NOT_DERIVATIVE','This job is not a reviewed privacy derivative');
 const review=(await deps.db.query<{approved:boolean;canonical_json:string;digest:string;signature:unknown}>('SELECT * FROM rnd_derivative_reviews WHERE analysis_id=$1 AND artifact_sha256=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[analysisId,artifact.sha256])).rows[0];
 if(!review?.approved)bad('RND_PRIVACY_REVIEW_REQUIRED','Review this exact derivative before external export',409);
 const details=row.result_json!.details as {observations:{record:Record<string,unknown>}[]};
 const record=details.observations[0].record;
 const disclosure={schemaVersion:'packproof.redacted-export.v1',transformation:record,review:{canonicalJson:review.canonical_json,digest:review.digest,signature:review.signature},verificationLevel:record.verificationLevel==='ZERO_KNOWLEDGE_TRANSFORM_PROOF'?'ZERO_KNOWLEDGE_TRANSFORM_PROOF':'SIGNED_TRANSFORMATION_RECORD',omissions:['Originals, thumbnails, transcripts, OCR, captions, source filenames, and source-dependent findings are omitted.','A downloaded archive cannot be revoked.'],trustList:deps.manifestSigning?.trustList??null};
 const signature=await signedRecord(deps,proofId,newId('rnd_disclosure'),disclosure);
 return streamZip((async function*(){yield zipBytes('disclosure.json',Buffer.from(canonicalize({disclosure,...signature})));yield zipBytes(String(artifact.mimeType).startsWith('video/')?'redacted.mp4':'redacted.png',bytes.body);})(),{beforeChunk:async()=>{await authorized(deps.db,proofId,actor);}});
}
