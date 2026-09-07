import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DomainError} from '../domain/errors.js';
import type {EncodedRecipientFile} from './recipient-profiles.js';
const exec=promisify(execFile);
const FONT='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
export const RENDERER_VERSION='packproof.recipient-frames.v1';
export function wrapRecipientText(text:string,width=88){return text.split('\n').flatMap(line=>{const words=line.split(/\s+/),out:string[]=[];let row='';for(const word of words){if(word.length>width){if(row)out.push(row);for(let i=0;i<word.length;i+=width)out.push(word.slice(i,i+width));row='';continue;}if((row+' '+word).trim().length>width){out.push(row);row=word;}else row=(row+' '+word).trim();}out.push(row);return out;});}
async function run(args:string[],timeout=60000){
 // Fixed tool/arguments, isolated local inputs, protocol and format allowlists,
 // hard CPU/address-space/output limits, and no credential-bearing child env.
 return exec('prlimit',['--as=805306368','--cpu=65','--fsize=12582912','--nofile=64','--','ffmpeg',...args],{timeout,maxBuffer:1024*1024,env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8',OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'}});
}
async function fontPath(){for(const candidate of [FONT,'/usr/share/fonts/dejavu/DejaVuSans.ttf','/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf'])try{await readFile(candidate);return candidate;}catch{}throw new DomainError('EXPORT_RENDERER_UNAVAILABLE','The export worker is missing its approved font.',503);}
const limits=['-nostdin','-y','-hide_banner','-threads','1','-filter_threads','1','-max_alloc','67108864'];
export async function renderFactsImages(text:string){const lines=wrapRecipientText(text),pages=[] as EncodedRecipientFile[];if(lines.length>180)throw new DomainError('EXPORT_RELEVANCE_REQUIRED','Select a shorter factual narrative for a readable packet.',413);const dir=await mkdtemp(path.join(os.tmpdir(),'packproof-export-'));try{const font=await fontPath();for(let page=0;page<Math.ceil(lines.length/60);page++){const txt=path.join(dir,`text${page}.txt`),jpg=path.join(dir,`facts${page}.jpg`);await writeFile(txt,lines.slice(page*60,(page+1)*60).join('\n'),{mode:0o600});await run([...limits,'-v','error','-f','lavfi','-i','color=c=white:s=1500x2000:r=1','-vf',`drawtext=fontfile=${font}:textfile=${txt}:expansion=none:fontsize=25:fontcolor=0x182d40:line_spacing=6:x=45:y=45`,'-frames:v','1','-threads:v','1','-q:v','3','-map_metadata','-1',jpg]);pages.push({name:`facts-${page+1}.jpg`,contentType:'image/jpeg',bytes:await readFile(jpg),pages:1,width:1500,height:2000});}return pages;}finally{await rm(dir,{recursive:true,force:true});}}
export async function extractRecipientFrame(source:Buffer|string,offsetMs:number,label:string){const dir=await mkdtemp(path.join(os.tmpdir(),'packproof-frame-'));try{
 const input=typeof source==='string'?source:path.join(dir,'source'),frame=path.join(dir,'frame.png'),out=path.join(dir,'file.jpg'),caption=path.join(dir,'caption.txt');if(typeof source!=='string')await writeFile(input,source,{mode:0o600});
 const result=await run([...limits,'-v','info','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,avi,png_pipe,jpeg_pipe','-i',input,'-map','0:v:0','-vf',`select=gte(t\\,${offsetMs/1000}),showinfo`,'-frames:v','1','-an','-sn','-dn','-map_metadata','-1','-map_chapters','-1',frame]);
 const match=/pts_time:([0-9.]+)/.exec(result.stderr);const actualMs=match?Math.round(Number(match[1])*1000):NaN;
 if(!Number.isSafeInteger(actualMs)||actualMs<offsetMs-1)throw new DomainError('EXPORT_FRAME_OFFSET_UNAVAILABLE','The requested frame could not be resolved to a source presentation timestamp.',409);
 const dimensions=/\bs:(\d+)x(\d+)/.exec(result.stderr);
 if(!dimensions||Math.min(Number(dimensions[1]),Number(dimensions[2]))<480)throw new DomainError('EXPORT_SOURCE_RESOLUTION','The source frame is too small for a readable recipient packet. Choose a higher-resolution original.',409);
 const originalFrame=await readFile(frame),font=await fontPath();
 await writeFile(caption,wrapRecipientText(`${label}\nFrame extracted from recording at ${(actualMs/1000).toFixed(3)} seconds.\nFull frame shown; scaled to fit. Original recording remains preserved.`,80).join('\n'),{mode:0o600});
 await run([...limits,'-v','error','-protocol_whitelist','file,pipe','-i',frame,'-vf',`scale=1500:1700:force_original_aspect_ratio=decrease,pad=1500:2000:(ow-iw)/2:40:color=white,drawtext=fontfile=${font}:textfile=${caption}:expansion=none:fontsize=26:fontcolor=0x182d40:line_spacing=6:x=40:y=1820`,'-frames:v','1','-threads:v','1','-q:v','3','-an','-map_metadata','-1',out]);
 return {file:{name:'frame.jpg',contentType:'image/jpeg',bytes:await readFile(out),pages:1,width:1500,height:2000} as EncodedRecipientFile,originalFrame,actualMs,toolVersion:(await exec('ffmpeg',['-version'],{timeout:5000,maxBuffer:20000,env:{PATH:process.env.PATH}})).stdout.split('\n')[0]};
 }finally{await rm(dir,{recursive:true,force:true});}}
/** Minimal deterministic image-only PDF: embedded JPEGs, no external resources, scripts or links. */
export function recipientPdf(images:EncodedRecipientFile[]):EncodedRecipientFile {
 const objects:Buffer[]=[];const put=(s:string|Buffer)=>{objects.push(typeof s==='string'?Buffer.from(s):s);return objects.length;};
 put('<< /Type /Catalog /Pages 2 0 R >>');put('');const kids:number[]=[];
 for(const img of images){if(img.contentType!=='image/jpeg')throw new Error('PDF requires encoded JPEG');const page=objects.length+1,content=page+1,picture=page+2;kids.push(page);put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 540 720] /Resources << /XObject << /Im ${picture} 0 R >> >> /Contents ${content} 0 R >>`);const stream='q 540 0 0 720 0 0 cm /Im Do Q';put(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);put(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`),img.bytes,Buffer.from('\nendstream')]));}
 objects[1]=Buffer.from(`<< /Type /Pages /Count ${kids.length} /Kids [${kids.map(k=>`${k} 0 R`).join(' ')}] >>`);const parts=[Buffer.from('%PDF-1.4\n%PackProof\n')],offsets=[0];let pos=parts[0].length;objects.forEach((o,i)=>{offsets.push(pos);const b=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),o,Buffer.from('\nendobj\n')]);parts.push(b);pos+=b.length;});parts.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(o=>`${String(o).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`));return {name:'review-packet.pdf',contentType:'application/pdf',bytes:Buffer.concat(parts),pages:images.length};
}
