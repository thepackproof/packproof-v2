import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DomainError } from './errors.js';
import { CAPTURE_MAX_BYTES } from './capture-sessions.js';
const run = promisify(execFile);
/** Container validation checks decodable packet structure, not truth or physical camera origin. */
export async function validateCapturedMedia(bytes: Buffer, contentType: string): Promise<{ durationMs: number | null }> {
  if (bytes.length < 32 || bytes.length > CAPTURE_MAX_BYTES)
    throw new DomainError('INVALID_CAPTURE_MEDIA','The recording is empty, truncated, or too large',422);
  const type=contentType.split(';')[0].trim().toLowerCase();
  const mp4=bytes.subarray(4,8).toString('ascii')==='ftyp';
  const webm=bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
  if ((type==='video/webm' && !webm) || (['video/mp4','video/quicktime'].includes(type) && !mp4))
    throw new DomainError('INVALID_CAPTURE_MEDIA','The recording container does not match its declared format',422);
  const dir=await mkdtemp(path.join(tmpdir(),'packproof-media-'));
  try {
    const filename=path.join(dir,'recording'); await writeFile(filename,bytes,{mode:0o600});
    const result=await run('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-count_packets','-show_entries','stream=codec_type,codec_name,nb_read_packets,width,height:format=duration','-of','json',filename],{timeout:30_000,maxBuffer:256*1024});
    const media=JSON.parse(result.stdout) as {format?:{duration?:string};streams?: Array<{codec_type?:string;codec_name?:string;nb_read_packets?:string;width?:number;height?:number}>};
    if (Number(media.format?.duration)>30*60 || result.stderr.trim() || !media.streams?.some(s=>s.codec_type==='video' && s.codec_name && Number(s.nb_read_packets)>0 && Number(s.width)>0 && Number(s.height)>0))
      throw new DomainError('INVALID_CAPTURE_MEDIA','The recording is incomplete, too long, or has no playable video stream',422);
    const duration=Number(media.format?.duration);
    return {durationMs:Number.isFinite(duration) && duration>0 ? Math.ceil(duration*1000) : null};
  } catch(error) {
    if (error instanceof DomainError) throw error;
    if ((error as NodeJS.ErrnoException).code==='ENOENT')
      throw new DomainError('CAPTURE_VALIDATION_UNAVAILABLE','Recording validation is temporarily unavailable. Your upload is preserved; retry shortly.',503);
    throw new DomainError('INVALID_CAPTURE_MEDIA','The recording could not be validated. Preserve the original and retry or record again.',422);
  } finally { await rm(dir,{recursive:true,force:true}); }
}
