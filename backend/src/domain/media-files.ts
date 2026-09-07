import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Database } from '../db/database.js';
import type { ObjectStore } from '../s3/object-store.js';
import { readCommittedEvidenceStream, type EvidenceStreamView } from './evidence.js';
import { DomainError } from './errors.js';
/** Spool only the exact authorized original; renderers open the file only after
 * complete-file verification has finished. Memory is bounded to stream buffers. */
export async function spoolCommittedEvidence(db:Database,store:ObjectStore,userId:string,proofId:string,evidenceId:string,filename:string,maximumBytes=250_000_000):Promise<{sha256:string;byteSize:number;contentType:string}>{
  const source=await readCommittedEvidenceStream(db,store,userId,proofId,evidenceId);
  return spoolPreservedStream(source,filename,maximumBytes);
}
export async function spoolPreservedStream(source:EvidenceStreamView,filename:string,maximumBytes=250_000_000):Promise<{sha256:string;byteSize:number;contentType:string}>{
  if(!source.body||source.status!==200||source.byteSize>maximumBytes){source.body?.destroy();throw new DomainError('MEDIA_PROCESSING_LIMIT','This recording exceeds the processing limit',413);}
  const hash=createHash('sha256');let count=0;
  async function* verified(){for await(const part of source.body!){const bytes=Buffer.from(part);count+=bytes.length;if(count>source.byteSize||count>maximumBytes)throw new DomainError('EVIDENCE_INTEGRITY_FAILURE','Source exceeded its preserved size',409);hash.update(bytes);yield bytes;}}
  await pipeline(Readable.from(verified()),createWriteStream(filename,{mode:0o600,flags:'wx',highWaterMark:64*1024}));
  if(count!==source.byteSize||hash.digest('hex')!==source.sha256)throw new DomainError('EVIDENCE_INTEGRITY_FAILURE','The original failed full-file verification',409);
  return {sha256:source.sha256,byteSize:count,contentType:source.contentType};
}
