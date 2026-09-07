import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DomainError } from './errors.js';
import { CAPTURE_MAX_BYTES } from './capture-sessions.js';
const run=promisify(execFile);
let activeValidators=0;
const MAX_VALIDATORS=2;
/** The preserved digest always covers complete original bytes; container checks
 * establish playable structure, never physical origin or truth of the video. */
export async function validateCapturedMedia(bytes:Buffer,contentType:string):Promise<{durationMs:number|null}>{
  return validateCapturedMediaStream(Readable.from([bytes]),contentType,{byteSize:bytes.length,maxDurationMs:30*60*1000});
}
export async function validateCapturedMediaStream(body:Readable,contentType:string,expected:{byteSize:number;sha256?:string;maxDurationMs?:number}):Promise<{durationMs:number|null}>{
  if(expected.byteSize<32||expected.byteSize>CAPTURE_MAX_BYTES){body.destroy();throw new DomainError('INVALID_CAPTURE_MEDIA','The recording is empty, truncated, or too large',422);}
  if(activeValidators>=MAX_VALIDATORS){body.destroy();throw new DomainError('CAPTURE_VALIDATION_BUSY','Recording validation is busy. Your upload is saved; retry shortly.',429);}
  activeValidators++;
  let directory:string|undefined;
  try{
    directory=await mkdtemp(path.join(tmpdir(),'packproof-media-'));const filename=path.join(directory,'recording');
    const hash=createHash('sha256');let byteSize=0,prefix=Buffer.alloc(0);
    async function* verified(){for await(const part of body){const bytes=Buffer.from(part);byteSize+=bytes.length;if(byteSize>expected.byteSize||byteSize>CAPTURE_MAX_BYTES)throw new DomainError('INVALID_CAPTURE_MEDIA','Recording exceeds its declared limit',422);hash.update(bytes);if(prefix.length<32)prefix=Buffer.concat([prefix,bytes.subarray(0,32-prefix.length)]);yield bytes;}}
    await pipeline(Readable.from(verified()),createWriteStream(filename,{mode:0o600,flags:'wx',highWaterMark:64*1024}));
    const digest=hash.digest('hex');
    if(byteSize!==expected.byteSize||(expected.sha256&&digest!==expected.sha256))throw new DomainError('EVIDENCE_INTEGRITY_FAILURE','The original failed complete-file integrity verification',409);
    assertVideoContainer(prefix,contentType);
    const args=['-v','error','-max_alloc','67108864','-protocol_whitelist','file,pipe','-count_packets','-show_entries','stream=codec_type,codec_name,nb_read_packets,width,height:format=duration','-of','json',filename];
    // Linux production images require util-linux/prlimit. No unsandboxed parser
    // fallback: a missing resource limiter is an availability failure.
    const result=process.platform==='linux'
      ?await run('prlimit',['--as=536870912','--cpu=25','--fsize=1048576','--nofile=64','--','ffprobe',...args],{timeout:30_000,killSignal:'SIGKILL',maxBuffer:256*1024,env:{PATH:process.env.PATH,LANG:'C'}})
      :await run('ffprobe',args,{timeout:30_000,killSignal:'SIGKILL',maxBuffer:256*1024,env:{PATH:process.env.PATH,LANG:'C'}});
    const media=JSON.parse(result.stdout) as {format?:{duration?:string};streams?:Array<{codec_type?:string;codec_name?:string;nb_read_packets?:string;width?:number;height?:number}>};
    const duration=Number(media.format?.duration),maxDuration=expected.maxDurationMs??300_000;
    if(!Number.isFinite(duration)||duration<=0||duration*1000>maxDuration||result.stderr.trim()||!media.streams?.some(s=>s.codec_type==='video'&&s.codec_name&&Number(s.nb_read_packets)>0&&Number(s.width)>0&&Number(s.height)>0&&Number(s.width)*Number(s.height)<=33_554_432))throw new DomainError('INVALID_CAPTURE_MEDIA','The recording is incomplete, exceeds its capture limit, or has no supported playable video stream',422);
    return {durationMs:Math.ceil(duration*1000)};
  }catch(error){
    if(error instanceof DomainError)throw error;
    if((error as NodeJS.ErrnoException).code==='ENOENT')throw new DomainError('CAPTURE_VALIDATION_UNAVAILABLE','Recording validation is temporarily unavailable. Keep the original and retry shortly.',503);
    throw new DomainError('INVALID_CAPTURE_MEDIA','The recording could not be validated. Preserve the original and retry or record again.',422);
  }finally{body.destroy();if(directory)await rm(directory,{recursive:true,force:true});activeValidators--;}
}
function assertVideoContainer(prefix:Buffer,contentType:string):void{
  const type=contentType.split(';')[0].trim().toLowerCase(),mp4=prefix.subarray(4,8).toString('ascii')==='ftyp',webm=prefix.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
  if((type==='video/webm'&&!webm)||(['video/mp4','video/quicktime'].includes(type)&&!mp4)||!['video/webm','video/mp4','video/quicktime'].includes(type))throw new DomainError('INVALID_CAPTURE_MEDIA','The recording container does not match its declared format',422);
}
