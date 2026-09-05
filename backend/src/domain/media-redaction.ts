import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import type { ObjectStore } from '../s3/object-store.js';
import { newId } from '../ids.js';
import { sha256Hex } from '../hash.js';
import { canonicalize } from '../canonical.js';
import { requireParticipant } from './proof-access.js';
import { readCommittedEvidence } from './evidence.js';
import { DomainError } from './errors.js';
import { appendAudit } from './audit.js';
const exec = promisify(execFile);
const VERSION='opaque-mask-silent/v1';
export interface RedactionMask { x:number;y:number;width:number;height:number }
export interface RedactionTransform { masks:RedactionMask[]; removeAudio:true; stripMetadata:true; withheldIntervals:never[] }
interface DerivativeRow { id:string;proof_id:string;evidence_id:string;source_sha256:string;transform_version:string;transform:RedactionTransform;status:string;sha256:string|null;object_key:string|null;content_type:string|null;byte_size:number|null;reviewed_at:string|null;failure_code:string|null }
function transformInput(input:unknown):RedactionTransform {
  const value=input as {masks?:unknown};
  if(!value||!Array.isArray(value.masks)||value.masks.length<1||value.masks.length>20) throw new DomainError('INVALID_REDACTION','Select between one and twenty opaque masks',400);
  const masks=value.masks.map((v:unknown)=>{
    const m=v as RedactionMask;
    if(!m||['x','y','width','height'].some(k=>typeof m[k as keyof RedactionMask]!=='number'||!Number.isFinite(m[k as keyof RedactionMask]))) throw new DomainError('INVALID_REDACTION','Mask coordinates must be normalized numbers',400);
    if(m.x<0||m.y<0||m.width<=0||m.height<=0||m.x+m.width>1||m.y+m.height>1) throw new DomainError('INVALID_REDACTION','Masks must fit within the image',400);
    return {x:m.x,y:m.y,width:m.width,height:m.height};
  });
  return {masks,removeAudio:true,stripMetadata:true,withheldIntervals:[]};
}
export function derivativeView(row:DerivativeRow) { return {derivativeId:row.id,evidenceId:row.evidence_id,sourceSha256:row.source_sha256,transformVersion:row.transform_version,transform:row.transform,status:row.status,sha256:row.sha256,contentType:row.content_type,byteSize:row.byte_size,reviewedAt:row.reviewed_at,failureCode:row.failure_code}; }
export async function listRedactions(db:Database,userId:string,proofId:string) { await requireParticipant(db,proofId,userId);return (await db.query<DerivativeRow>('SELECT * FROM proof_media_derivatives WHERE proof_id=$1 AND transform_version=$2 ORDER BY created_at DESC',[proofId,VERSION])).rows.map(derivativeView); }
async function performRedaction(db:Database,clock:Clock,store:ObjectStore,userId:string,proofId:string,evidenceId:string,input:unknown) {
  await requireParticipant(db,proofId,userId,'SELLER');
  const transform=transformInput(input);
  const source=await readCommittedEvidence(db,store,userId,proofId,evidenceId);
  if(source.body.length>100*1024*1024) throw new DomainError('REDACTION_LIMIT','This recording exceeds the 100 MB redaction limit',413);
  if(!source.contentType.startsWith('video/')&&!source.contentType.startsWith('image/')) throw new DomainError('REDACTION_UNSUPPORTED','Only image and video sources can be redacted',400);
  const digest=sha256Hex(source.body);
  let id=newId('pmd');
  const result=await db.query<DerivativeRow>('INSERT INTO proof_media_derivatives(id,proof_id,evidence_id,source_sha256,transform_version,transform,status,created_by_user_id,created_at,lease_until) VALUES($1,$2,$3,$4,$5,$6::jsonb,\'PENDING\',$7,$8,$9) ON CONFLICT(proof_id,evidence_id,source_sha256,transform_version,transform) DO NOTHING RETURNING *',[id,proofId,evidenceId,digest,VERSION,canonicalize(transform),userId,clock.now().toISOString(),new Date(clock.now().getTime()+180000).toISOString()]);
  if(!result.rows[0]) {
    const prior=(await db.query<DerivativeRow>('SELECT * FROM proof_media_derivatives WHERE proof_id=$1 AND evidence_id=$2 AND source_sha256=$3 AND transform_version=$4 AND transform=$5::jsonb',[proofId,evidenceId,digest,VERSION,canonicalize(transform)])).rows[0];
    if(prior.status==='READY'||prior.status==='REVIEWED') return derivativeView(prior);
    const retried=await db.query("UPDATE proof_media_derivatives SET status='PENDING',attempt_count=attempt_count+1,lease_until=$2,failure_code=NULL WHERE id=$1 AND attempt_count<3 AND (status='FAILED' OR (status='PENDING' AND lease_until<=$3)) RETURNING id",[prior.id,new Date(clock.now().getTime()+180000).toISOString(),clock.now().toISOString()]);
    if(!retried.rows[0]) return derivativeView(prior);
    id=prior.id;
  }
  const dir=await mkdtemp(path.join(os.tmpdir(),'packproof-redact-'));
  try {
    await writeFile(path.join(dir,'input'),source.body,{mode:0o600});
    const metadata=await exec('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-select_streams','v:0','-show_entries','stream=width,height','-of','json',path.join(dir,'input')],{timeout:10000,maxBuffer:65536});
    const dimensions=JSON.parse(metadata.stdout).streams?.[0];
    if(!dimensions||!Number.isFinite(dimensions.width)||!Number.isFinite(dimensions.height)||dimensions.width*dimensions.height>16777216) throw new Error('Pixel limit');
    const video=source.contentType.startsWith('video/');
    const out=path.join(dir,video?'redacted.mp4':'redacted.png');
    // Fully opaque masks on EVERY frame. No original audio, metadata, attachments,
    // subtitles, hidden tracks or original thumbnails enter this representation.
    const filters=transform.masks.map(m=>`drawbox=x=floor(iw*${m.x}):y=floor(ih*${m.y}):w=ceil(iw*${m.x+m.width})-floor(iw*${m.x}):h=ceil(ih*${m.y+m.height})-floor(ih*${m.y}):color=black:t=fill`).join(',');
    await exec('ffmpeg',['-nostdin','-v','error','-y','-protocol_whitelist','file,pipe','-i',path.join(dir,'input'),'-map','0:v:0','-vf',filters,'-an','-sn','-dn','-map_metadata','-1','-map_chapters','-1',...(video?['-c:v','libx264','-preset','fast','-pix_fmt','yuv420p','-movflags','+faststart']:['-frames:v','1']),out],{timeout:120000,maxBuffer:1024*1024});
    const body=await readFile(out);
    if(!body.length||body.length>100*1024*1024) throw new Error('Output limit');
    const hash=sha256Hex(body),key=`derivatives/${proofId}/${id}/${hash}`,contentType=video?'video/mp4':'image/png';
    await store.put(key,body,contentType);
    await db.query('UPDATE proof_media_derivatives SET status=\'READY\',sha256=$2,object_key=$3,content_type=$4,byte_size=$5 WHERE id=$1 AND status=\'PENDING\'',[id,hash,key,contentType,body.length]);
  } catch {
    await db.query('UPDATE proof_media_derivatives SET status=\'FAILED\',failure_code=\'RENDER_FAILED\' WHERE id=$1 AND status=\'PENDING\'',[id]);
  } finally { await rm(dir,{recursive:true,force:true}); }
  return derivativeView((await db.query<DerivativeRow>('SELECT * FROM proof_media_derivatives WHERE id=$1',[id])).rows[0]);
}
export async function readRedactionForReview(db:Database,store:ObjectStore,userId:string,proofId:string,id:string) {
  await requireParticipant(db,proofId,userId,'SELLER');
  const row=(await db.query<DerivativeRow>('SELECT * FROM proof_media_derivatives WHERE id=$1 AND proof_id=$2 AND status IN (\'READY\',\'REVIEWED\') AND transform_version=$3',[id,proofId,VERSION])).rows[0];
  if(!row?.object_key) throw new DomainError('DERIVATIVE_UNAVAILABLE','The redaction is not ready to review',409);
  const stored=await store.get(row.object_key);
  if(!stored||sha256Hex(stored.body)!==row.sha256) throw new DomainError('DERIVATIVE_UNAVAILABLE','The redaction is unavailable',409);
  return {body:stored.body,contentType:row.content_type!,sha256:row.sha256!};
}
export async function approveRedaction(db:Database,clock:Clock,store:ObjectStore,userId:string,proofId:string,id:string,reviewedHash:unknown) {
  const media=await readRedactionForReview(db,store,userId,proofId,id);
  if(reviewedHash!==media.sha256) throw new DomainError('REDACTION_REVIEW_REQUIRED','Confirm the exact redacted copy after reviewing it',409);
  await db.transaction(async tx=>{
    await tx.query('UPDATE proof_media_derivatives SET status=\'REVIEWED\',reviewed_by_user_id=$3,reviewed_at=$4 WHERE id=$1 AND proof_id=$2 AND status=\'READY\'',[id,proofId,userId,clock.now().toISOString()]);
    await appendAudit(tx,{proofId,actorUserId:userId,eventType:'MEDIA_REDACTION_REVIEWED',eventData:{derivativeId:id,sha256:media.sha256,transformVersion:VERSION},at:clock.now()});
  });
  return derivativeView((await db.query<DerivativeRow>('SELECT * FROM proof_media_derivatives WHERE id=$1',[id])).rows[0]);
}

let activeRenders=0;
export async function renderRedaction(db:Database,clock:Clock,store:ObjectStore,userId:string,proofId:string,evidenceId:string,input:unknown) {
  if(process.env.PACKPROOF_REDACTION_ENABLED==='false') throw new DomainError('REDACTION_DISABLED','Redacted sharing is temporarily disabled',503);
  if(activeRenders>=2) throw new DomainError('REDACTION_BUSY','Media processing is busy; retry shortly',429);
  activeRenders++;
  try { return await performRedaction(db,clock,store,userId,proofId,evidenceId,input); }
  finally {activeRenders--;}
}
