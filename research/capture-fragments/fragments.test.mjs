import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {canonicalize} from '../../packages/evidence-contracts/contracts.mjs';
import {FragmentJournal,ClosedFmp4Stream,verifyFragmentManifest,nativeFragmentCapability} from '../../packages/evidence-contracts/fragments.mjs';
import {captureSoftwareFragments} from './run-spike.mjs';
const exec=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');let fixture;
before(async()=>{fixture=await captureSoftwareFragments({seconds:2,realTime:false});});
test('actual encoded AVC/AAC initialization and media fragments have complete declared byte coverage',async()=>{
 assert.equal(fixture.verification.valid,true);assert.equal(fixture.verification.audioCoverage,'ENCODED_BYTES_CHECKED');assert.equal(fixture.report.tracks.find(t=>t.kind==='VIDEO').codec,'avc1');assert.equal(fixture.report.tracks.find(t=>t.kind==='AUDIO').codec,'mp4a');
 const directory=await mkdtemp(path.join(tmpdir(),'fragment-decode-'));try{const file=path.join(directory,'actual.mp4');await writeFile(file,Buffer.concat(fixture.units));const {stdout}=await exec('ffprobe',['-v','error','-count_packets','-show_entries','stream=codec_name,codec_type,nb_read_packets','-of','json',file]);const streams=JSON.parse(stdout).streams;assert.equal(streams.length,2);for(const stream of streams)assert.ok(Number(stream.nb_read_packets)>1);assert.deepEqual(new Set(streams.map(s=>s.codec_type)),new Set(['video','audio']));}finally{await rm(directory,{recursive:true,force:true});}
});
test('incremental transport chunk boundaries do not alter emitted closed units',()=>{
 const parser=new ClosedFmp4Stream(),stream=Buffer.concat(fixture.units),result=[];for(let i=0;i<stream.length;i+=113)result.push(...parser.push(stream.subarray(i,i+113)));parser.finish();assert.deepEqual(result.map(u=>u.bytes),fixture.units);assert.throws(()=>parser.push(Buffer.alloc(1)),/STREAM_CLOSED/);
});
test('omission, truncation, reordering and inserted fragments all fail exact signed inventory',()=>{
 const examples=[fixture.units.slice(0,-1),fixture.units.filter((_,index)=>index!==1),[fixture.units[1],fixture.units[0],...fixture.units.slice(2)],[...fixture.units,fixture.units[1]],fixture.units.map((b,i)=>i===1?b.subarray(0,b.length-1):b)];
 for(const units of examples)assert.throws(()=>verifyFragmentManifest(fixture.sealed,units,fixture.publicKeyPem));
});
test('byte tampering, changed nonce/session, wrong key and forged assurance are rejected',()=>{
 const units=fixture.units.map(b=>Buffer.from(b));units[1][units[1].length-1]^=1;assert.throws(()=>verifyFragmentManifest(fixture.sealed,units,fixture.publicKeyPem),/CHAIN_MISMATCH/);
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKey=pair.publicKey.export({format:'pem',type:'spki'});assert.throws(()=>verifyFragmentManifest(fixture.sealed,fixture.units,publicKey),/SIGNATURE_INVALID/);
 for(const mutate of [m=>m.session.nonceDigest='a'.repeat(64),m=>m.session.captureSessionId='cap_rebound',m=>m.entries[1].previousDigest='0'.repeat(64),m=>m.nativeCaptureAssurance='VERIFIED']){
  const record=JSON.parse(fixture.sealed.canonicalJson);mutate(record);const canonicalJson=canonicalize(record),wrapper={canonicalJson,digest:sha(canonicalJson),signatureBase64:sign('sha256',Buffer.from(canonicalJson),pair.privateKey).toString('base64')};assert.throws(()=>verifyFragmentManifest(wrapper,fixture.units,publicKey));
 }
});
test('unfinished streams cannot seal and nonmonotonic closure timestamps fail',()=>{
 const session=JSON.parse(fixture.sealed.canonicalJson).session,journal=new FragmentJournal(session);journal.append({kind:'INIT',bytes:fixture.units[0],closedMonotonicNs:session.startedMonotonicNs});assert.throws(()=>journal.seal(generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey),/INCOMPLETE/);assert.throws(()=>journal.append({kind:'MEDIA',bytes:fixture.units[1],closedMonotonicNs:String(BigInt(session.startedMonotonicNs)-1n)}),/ORDER/);
 const parser=new ClosedFmp4Stream();parser.push(Buffer.concat(fixture.units).subarray(0,-1));assert.throws(()=>parser.finish(),/INCOMPLETE/);
});
test('both native adapters accurately remain final-file-only and unqualified',()=>{
 for(const platform of ['android','ios'])assert.deepEqual([nativeFragmentCapability(platform).activeProfile,nativeFragmentCapability(platform).incrementalFragments,nativeFragmentCapability(platform).hardwareQualified],['FINAL_FILE_ONLY','UNSUPPORTED',false]);
 assert.throws(()=>nativeFragmentCapability('simulated'),/UNKNOWN_NATIVE_PLATFORM/);
});
