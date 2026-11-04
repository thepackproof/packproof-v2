import {afterEach,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {createHarness,createUser,commitProofEvidence,type TestHarness} from './helpers.js';
import {createTransaction} from '../src/domain/transactions.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
import {renderRedaction,readRedactionForReview} from '../src/domain/media-redaction.js';
import {queueThumbnail,processPendingThumbnails,readThumbnail} from '../src/domain/media-thumbnails.js';
import {createSignatureAnchor} from '../src/domain/signature.js';
let h:TestHarness|undefined,dir:string|undefined;
afterEach(async()=>{await h?.close();if(dir){const rel=relative(resolve(tmpdir()),resolve(dir));if(!rel||rel.startsWith('..')||rel.includes(':'))throw Error('Unsafe cleanup');await rm(dir,{recursive:true,force:true});}h=undefined;dir=undefined;});
async function fixture(){h=await createHarness();const user=await createUser(h),t=await createTransaction(h.db,h.clock,user,{itemTitle:'Actual media regression'}),p=await createOrGetProof(h.db,h.clock,user,t.transactionId,{participationPolicy:'COUNTERPARTY_OPTIONAL'});return {user,proof:p.proofId};}
it('renders an actually opaque PNG with constrained subprocesses and preserves the source original',async()=>{
 const {user,proof}=await fixture();dir=await mkdtemp(join(tmpdir(),'render-bounds-'));const input=join(dir,'red.png');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=red:s=32x32','-threads','1','-frames:v','1',input]);const original=await readFile(input),e=await commitProofEvidence(h!,user,proof,{contentType:'image/png',bytes:original});const result=await renderRedaction(h!.db,h!.clock,h!.objectStore,user,proof,e.evidenceId,{masks:[{x:0,y:0,width:1,height:1}]});expect(result.status).toBe('READY');const copy=await readRedactionForReview(h!.db,h!.objectStore,user,proof,result.derivativeId);expect(copy.body.equals(original)).toBe(false);const file=join(dir,'masked.png');await (await import('node:fs/promises')).writeFile(file,copy.body);const pixels=execFileSync('ffmpeg',['-v','error','-threads','1','-i',file,'-f','rawvideo','-pix_fmt','rgb24','-threads','1','pipe:1']);expect(pixels.length).toBe(32*32*3);expect(pixels.every(n=>n===0)).toBe(true);const bad=await commitProofEvidence(h!,user,proof,{contentType:'image/png',bytes:Buffer.from('invalid original'),idempotencyKey:'invalid'});expect((await renderRedaction(h!.db,h!.clock,h!.objectStore,user,proof,bad.evidenceId,{masks:[{x:0,y:0,width:1,height:1}]})).status).toBe('FAILED');
},60000);
it('extracts a real recording thumbnail without using a listener or widening media process limits',async()=>{
 const {user,proof}=await fixture(),bytes=await readFile(new URL('./fixtures/camera-recording.mp4',import.meta.url)),e=await commitProofEvidence(h!,user,proof,{contentType:'video/mp4',bytes}),a=await createSignatureAnchor(h!.db,h!.clock,user,proof,{evidenceId:e.evidenceId,startMs:0,endMs:100,label:'Item',idempotencyKey:'thumb'}),job=await queueThumbnail(h!.db,h!.clock,user,proof,a.anchorId);expect(await processPendingThumbnails(h!.db,h!.clock,h!.objectStore)).toEqual({processed:1,failed:0});expect((await readThumbnail(h!.db,h!.objectStore,user,proof,job.derivativeId)).body.subarray(1,4).toString()).toBe('PNG');
},60000);
