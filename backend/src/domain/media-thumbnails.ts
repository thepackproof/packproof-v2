import {execFile} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import type {Clock} from '../clock.js';
import type {Database} from '../db/database.js';
import type {ObjectStore} from '../s3/object-store.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {newId} from '../ids.js';
import {requireParticipant} from './proof-access.js';
import {spoolCommittedEvidence} from './media-files.js';
import {DomainError} from './errors.js';
const exec=promisify(execFile);
const boundedExec=(command:string,args:string[],options:{timeout:number;maxBuffer:number})=>exec(process.platform==='linux'?'prlimit':command,process.platform==='linux'?['--as=536870912','--cpu=60','--fsize=2097152','--nofile=64','--',command,...args]:args,{...options,killSignal:'SIGKILL',env:{PATH:process.env.PATH,LANG:'C'}});
const VERSION='committed-source-thumbnail/v1';
interface ThumbnailTransform {anchorId:string;sourceVersion:string;startMs:number;endMs:number;elapsedMs:number;removeAudio:true;stripMetadata:true;withheldIntervals:never[]}
interface ThumbnailRow {id:string;proof_id:string;evidence_id:string;source_sha256:string;transform:ThumbnailTransform;status:string;sha256:string|null;object_key:string|null;content_type:string|null;byte_size:number|null;created_by_user_id:string;attempt_count:number;failure_code:string|null}
function view(r:ThumbnailRow){return {derivativeId:r.id,evidenceId:r.evidence_id,sourceSha256:r.source_sha256,transformVersion:VERSION,transform:r.transform,status:r.status,sha256:r.sha256,contentType:r.content_type,byteSize:r.byte_size,attemptCount:r.attempt_count,failureCode:r.failure_code};}
export async function queueThumbnail(db:Database,clock:Clock,userId:string,proofId:string,anchorId:string) {
  await requireParticipant(db,proofId,userId);
  if(process.env.PACKPROOF_REPLAY_THUMBNAILS==='false') throw new DomainError('THUMBNAILS_DISABLED','Replay thumbnails are temporarily disabled',503);
  const anchor=(await db.query<{payload_json:string}>('SELECT payload_json FROM evidence_anchors WHERE id=$1 AND proof_id=$2',[anchorId,proofId])).rows[0];
  if(!anchor) throw new DomainError('ANCHOR_NOT_FOUND','That chapter is unavailable',404);
  const a=JSON.parse(anchor.payload_json) as {evidenceId:string|null;sourceHash:string;sourceVersion:string;startMs:number|null;endMs:number|null;stageId:string|null};
  if(!a.evidenceId||a.stageId||a.startMs===null||a.endMs===null) throw new DomainError('THUMBNAIL_UNSUPPORTED','Only original recording chapters support thumbnails',400);
  const source=(await db.query<{sha256:string,content_type:string}>('SELECT sha256,content_type FROM evidence WHERE id=$1 AND proof_id=$2 AND validation_status=\'COMMITTED\'',[a.evidenceId,proofId])).rows[0];
  if(!source||source.sha256!==a.sourceHash||a.sourceVersion!==`sha256:${source.sha256}`||!source.content_type.startsWith('video/')) throw new DomainError('THUMBNAIL_SOURCE_UNAVAILABLE','The committed recording is unavailable',409);
  const transform:ThumbnailTransform={anchorId,sourceVersion:a.sourceVersion,startMs:a.startMs,endMs:a.endMs,elapsedMs:a.startMs,removeAudio:true,stripMetadata:true,withheldIntervals:[]};
  await db.query('INSERT INTO proof_media_derivatives(id,proof_id,evidence_id,source_sha256,transform_version,transform,status,created_by_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,\'PENDING\',$7,$8) ON CONFLICT(proof_id,evidence_id,source_sha256,transform_version,transform) DO NOTHING',[newId('pmd'),proofId,a.evidenceId,a.sourceHash,VERSION,canonicalize(transform),userId,clock.now().toISOString()]);
  return view((await db.query<ThumbnailRow>('SELECT * FROM proof_media_derivatives WHERE proof_id=$1 AND evidence_id=$2 AND transform_version=$3 AND transform=$4::jsonb',[proofId,a.evidenceId,VERSION,canonicalize(transform)])).rows[0]);
}
export async function listThumbnails(db:Database,userId:string,proofId:string) {
  await requireParticipant(db,proofId,userId);
  return (await db.query<ThumbnailRow>('SELECT * FROM proof_media_derivatives WHERE proof_id=$1 AND transform_version=$2 ORDER BY created_at',[proofId,VERSION])).rows.map(view);
}
export async function readThumbnail(db:Database,store:ObjectStore,userId:string,proofId:string,id:string) {
  await requireParticipant(db,proofId,userId);
  const row=(await db.query<ThumbnailRow>('SELECT * FROM proof_media_derivatives WHERE id=$1 AND proof_id=$2 AND transform_version=$3 AND status=\'READY\'',[id,proofId,VERSION])).rows[0];
  if(!row?.object_key) throw new DomainError('THUMBNAIL_UNAVAILABLE','This optional thumbnail is unavailable. Open the recording instead.',409);
  const source=(await db.query<{sha256:string}>('SELECT sha256 FROM evidence WHERE id=$1 AND proof_id=$2',[row.evidence_id,proofId])).rows[0];
  const media=await store.get(row.object_key);
  if(!source||source.sha256!==row.source_sha256||!media||sha256Hex(media.body)!==row.sha256||media.body.length!==Number(row.byte_size)) throw new DomainError('THUMBNAIL_UNAVAILABLE','This optional thumbnail is unavailable',409);
  return {body:media.body,contentType:'image/png'};
}
export async function processPendingThumbnails(db:Database,clock:Clock,store:ObjectStore) {
  if(process.env.PACKPROOF_REPLAY_THUMBNAILS==='false') return {processed:0,failed:0};
  const now=clock.now();
  await db.query("UPDATE proof_media_derivatives SET status='FAILED',failure_code='THUMBNAIL_ATTEMPTS_EXHAUSTED' WHERE transform_version=$1 AND status='PENDING' AND attempt_count>=3 AND lease_until<=$2",[VERSION,now.toISOString()]);
  const pending=(await db.query<ThumbnailRow>(`SELECT * FROM proof_media_derivatives WHERE transform_version=$1 AND (status='PENDING' OR (status='FAILED' AND attempt_count<3)) AND (lease_until IS NULL OR lease_until<=$2) ORDER BY created_at LIMIT 1`,[VERSION,now.toISOString()])).rows[0];
  if(!pending)return {processed:0,failed:0};
  const lease=new Date(now.getTime()+120000).toISOString();
  const claimed=await db.query(`UPDATE proof_media_derivatives SET status='PENDING',lease_until=$2,attempt_count=CASE WHEN lease_until IS NOT NULL THEN attempt_count+1 ELSE attempt_count END WHERE id=$1 AND (attempt_count<3 OR lease_until IS NULL) AND (status='PENDING' OR (status='FAILED' AND attempt_count<3)) AND (lease_until IS NULL OR lease_until<=$3) RETURNING id`,[pending.id,lease,now.toISOString()]);
  if(!claimed.rows[0])return {processed:0,failed:0};
  let dir:string|undefined;
  try {
    dir=await mkdtemp(path.join(os.tmpdir(),'packproof-thumbnail-'));
    const input=path.join(dir,'source'),output=path.join(dir,'thumb.png');
    const original=await spoolCommittedEvidence(db,store,pending.created_by_user_id,pending.proof_id,pending.evidence_id,input);
    if(original.sha256!==pending.source_sha256)throw new Error('Source digest');
    const probe=await boundedExec('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration','-of','json',input],{timeout:10000,maxBuffer:64*1024});
    const durationMs=Number(JSON.parse(probe.stdout).format?.duration)*1000;
    if(!Number.isFinite(durationMs)||pending.transform.elapsedMs>=durationMs||pending.transform.endMs>durationMs+100) throw new Error('Range unavailable');
    await boundedExec('ffmpeg',['-nostdin','-v','error','-threads','1','-filter_threads','1','-y','-protocol_whitelist','file,pipe','-i',input,'-ss',String(pending.transform.elapsedMs/1000),'-map','0:v:0','-threads','1','-frames:v','1','-vf','scale=320:-2','-an','-sn','-dn','-map_metadata','-1','-map_chapters','-1',output],{timeout:60000,maxBuffer:1024*1024});
    const body=await readFile(output),hash=sha256Hex(body),key=`derivatives/${pending.proof_id}/${pending.id}/${hash}`;
    if(!body.length||body.length>1024*1024)throw new Error('Output limit');
    await store.put(key,body,'image/png');
    await db.query('UPDATE proof_media_derivatives SET status=\'READY\',sha256=$2,object_key=$3,content_type=\'image/png\',byte_size=$4,failure_code=NULL WHERE id=$1 AND status=\'PENDING\' AND lease_until=$5',[pending.id,hash,key,body.length,lease]);
    return {processed:1,failed:0};
  } catch {
    await db.query('UPDATE proof_media_derivatives SET status=\'FAILED\',failure_code=\'THUMBNAIL_FAILED\',lease_until=$2 WHERE id=$1 AND status=\'PENDING\' AND lease_until=$3',[pending.id,new Date(clock.now().getTime()+30000).toISOString(),lease]);
    return {processed:0,failed:1};
  } finally {if(dir)await rm(dir,{recursive:true,force:true});}
}
