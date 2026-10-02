/** Node-only software protocol spike. No camera/sensor assurance; never splits a finalized recording. */
import {createHash,createPublicKey,sign,verify} from 'node:crypto';
import {canonicalize} from './contracts.mjs';
export const FRAGMENT_PROFILE='packproof.software-fmp4-spike.v1';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw Error(code);};
const digest=/^[a-f0-9]{64}$/;
const MAX_FRAGMENT_BYTES=16*1024*1024, MAX_FRAGMENTS=2048, MAX_STREAM_BYTES=128*1024*1024;
export function mp4Boxes(bytes) {
 if(!Buffer.isBuffer(bytes)||bytes.length>MAX_FRAGMENT_BYTES)fail('FRAGMENT_SIZE_LIMIT');
 const result=[];let at=0;
 while(at<bytes.length){if(at+8>bytes.length)fail('TRUNCATED_MP4_BOX');let size=bytes.readUInt32BE(at),header=8;const type=bytes.toString('ascii',at+4,at+8);
  if(size===1){if(at+16>bytes.length)fail('TRUNCATED_MP4_BOX');const large=bytes.readBigUInt64BE(at+8);if(large>BigInt(MAX_FRAGMENT_BYTES))fail('FRAGMENT_SIZE_LIMIT');size=Number(large);header=16;}
  if(size<header||at+size>bytes.length||!/^[A-Za-z0-9 ]{4}$/.test(type))fail('INVALID_MP4_BOX');
  result.push({type,bytes:bytes.subarray(at,at+size),body:bytes.subarray(at+header,at+size)});at+=size;
 }return result;
}
const one=(boxes,type)=>{const found=boxes.filter(b=>b.type===type);if(found.length!==1)fail(`EXPECTED_ONE_${type}`);return found[0];};
const u32=(bytes,offset)=>{if(offset<0||offset+4>bytes.length)fail('TRUNCATED_MP4_FIELD');return bytes.readUInt32BE(offset);};
const flags=body=>u32(body,0)&0xffffff;
function trackInfo(init) {
 const boxes=mp4Boxes(init);if(boxes.length!==2||boxes[0].type!=='ftyp'||boxes[1].type!=='moov')fail('UNSUPPORTED_INIT_LAYOUT');
 const moov=mp4Boxes(boxes[1].body),defaults=new Map(mp4Boxes(one(moov,'mvex').body).filter(b=>b.type==='trex').map(b=>[u32(b.body,4),u32(b.body,12)]));
 const tracks=moov.filter(b=>b.type==='trak').map(trak=>{
  const children=mp4Boxes(trak.body),tkhd=one(children,'tkhd').body,mdia=mp4Boxes(one(children,'mdia').body),mdhd=one(mdia,'mdhd').body,handler=one(mdia,'hdlr').body.toString('ascii',8,12);
  if(!['vide','soun'].includes(handler)||tkhd[0]>1||mdhd[0]>1)fail('UNSUPPORTED_MEDIA_TRACK');
  const trackId=u32(tkhd,tkhd[0]===1?20:12),timescale=u32(mdhd,mdhd[0]===1?20:12),stbl=mp4Boxes(one(mp4Boxes(one(mdia,'minf').body),'stbl').body),stsd=one(stbl,'stsd').body;
  if(u32(stsd,4)!==1||stsd.length<16||!timescale||!trackId||!defaults.has(trackId))fail('INVALID_TRACK_DESCRIPTION');
  return {trackId,kind:handler==='vide'?'VIDEO':'AUDIO',timescale,codec:stsd.toString('ascii',12,16),defaultSampleDuration:defaults.get(trackId)};
 });
 if(tracks.length<1||tracks.length>2||new Set(tracks.map(t=>t.trackId)).size!==tracks.length||tracks.filter(t=>t.kind==='VIDEO').length!==1||tracks.filter(t=>t.kind==='AUDIO').length>1)fail('UNSUPPORTED_TRACK_INVENTORY');
 return tracks;
}
function mediaInfo(bytes,tracks) {
 const boxes=mp4Boxes(bytes);if(boxes.length!==2||boxes[0].type!=='moof'||boxes[1].type!=='mdat'||!boxes[1].body.length)fail('UNSUPPORTED_MEDIA_LAYOUT');
 const moof=mp4Boxes(boxes[0].body),fragmentSequence=u32(one(moof,'mfhd').body,4);
 const timing=moof.filter(b=>b.type==='traf').map(traf=>{
  const children=mp4Boxes(traf.body),tfhd=one(children,'tfhd').body,tfdt=one(children,'tfdt').body,trackId=u32(tfhd,4),track=tracks.find(t=>t.trackId===trackId);
  if(!track||![0,1].includes(tfdt[0]))fail('UNKNOWN_FRAGMENT_TRACK');
  const f=flags(tfhd);let offset=8;if(f&1)offset+=8;if(f&2)offset+=4;
  const duration=f&8?u32(tfhd,offset):track.defaultSampleDuration;
  const decodeTime=tfdt[0]===1?(tfdt.length>=12?tfdt.readBigUInt64BE(4):fail('TRUNCATED_MP4_FIELD')):BigInt(u32(tfdt,4));
  let sampleCount=0,totalDuration=0n;
  for(const trun of children.filter(b=>b.type==='trun')){
   const b=trun.body,fl=flags(b),count=u32(b,4);if(count<1||count>100000)fail('FRAGMENT_SAMPLE_LIMIT');let at=8;if(fl&1)at+=4;if(fl&4)at+=4;
   for(let i=0;i<count;i++){const sampleDuration=fl&0x100?u32(b,at):duration;if(!sampleDuration)fail('SAMPLE_DURATION_REQUIRED');if(fl&0x100)at+=4;if(fl&0x200)at+=4;if(fl&0x400)at+=4;if(fl&0x800)at+=4;if(at>b.length)fail('TRUNCATED_SAMPLE_TABLE');totalDuration+=BigInt(sampleDuration);}
   if(at!==b.length)fail('UNSUPPORTED_SAMPLE_TABLE');sampleCount+=count;
  }
  if(sampleCount<1)fail('EMPTY_FRAGMENT_TRACK');return {trackId,kind:track.kind,timescale:track.timescale,decodeStartTicks:String(decodeTime),decodeEndTicks:String(decodeTime+totalDuration),sampleCount};
 });
 if(!timing.length||new Set(timing.map(t=>t.trackId)).size!==timing.length)fail('DUPLICATE_FRAGMENT_TRACK');
 return {fragmentSequence,timing};
}
/** Accepts live stream chunks, emits only complete init/media/index units, bounds pending native-independent memory. */
export class ClosedFmp4Stream {
 constructor(){this.pending=Buffer.alloc(0);this.prefix=[];this.phase='INIT';this.moof=null;this.closed=false;}
 push(chunk){if(this.closed||!Buffer.isBuffer(chunk))fail('STREAM_CLOSED');this.pending=Buffer.concat([this.pending,chunk]);if(this.pending.length>MAX_FRAGMENT_BYTES)fail('FRAGMENT_SIZE_LIMIT');const units=[];
  while(this.pending.length>=8){let size=this.pending.readUInt32BE(0);if(size===1){if(this.pending.length<16)break;const big=this.pending.readBigUInt64BE(8);if(big>BigInt(MAX_FRAGMENT_BYTES))fail('FRAGMENT_SIZE_LIMIT');size=Number(big);}if(size<8||size>MAX_FRAGMENT_BYTES)fail('INVALID_MP4_BOX');if(this.pending.length<size)break;
   const box=Buffer.from(this.pending.subarray(0,size));this.pending=this.pending.subarray(size);const type=box.toString('ascii',4,8);
   if(this.phase==='FINAL')fail('TRAILING_FRAGMENT_BYTES');
   if(this.phase==='INIT'){const expected=this.prefix.length?'moov':'ftyp';if(type!==expected)fail('UNSUPPORTED_INIT_LAYOUT');this.prefix.push(box);if(type==='moov'){units.push({kind:'INIT',bytes:Buffer.concat(this.prefix)});this.prefix=[];this.phase='MEDIA';}}
   else if(type==='moof'&&!this.moof)this.moof=box;
   else if(type==='mdat'&&this.moof){units.push({kind:'MEDIA',bytes:Buffer.concat([this.moof,box])});this.moof=null;}
   else if(type==='mfra'&&!this.moof){units.push({kind:'FINAL_INDEX',bytes:box});this.phase='FINAL';}
   else fail('UNSUPPORTED_FRAGMENT_LAYOUT');
  }return units;
 }
 finish(){if(this.pending.length||this.moof||this.phase!=='FINAL')fail('INCOMPLETE_FRAGMENT_STREAM');this.closed=true;}
}
function sessionContext(input){
 if(!input||input.profile!==FRAGMENT_PROFILE||!['proofId','captureSessionId'].every(k=>typeof input[k]==='string'&&/^[A-Za-z0-9_-]{1,180}$/.test(input[k]))||!digest.test(input.nonceDigest)||typeof input.audioRequired!=='boolean'||!/^\d{1,20}$/.test(input.startedMonotonicNs))fail('INVALID_FRAGMENT_SESSION');
 return {schemaVersion:'packproof.fragment-session.v1',profile:FRAGMENT_PROFILE,proofId:input.proofId,captureSessionId:input.captureSessionId,nonceDigest:input.nonceDigest,audioRequired:input.audioRequired,startedMonotonicNs:input.startedMonotonicNs,clockDomain:'PROCESS_MONOTONIC_NS',qualification:'SOFTWARE_PROTOCOL_ONLY'};
}
export class FragmentJournal {
 constructor(session){this.session=sessionContext(session);this.sessionDigest=sha(canonicalize(this.session));this.entries=[];this.bytes=[];this.tracks=[];this.lastMediaSequence=0;this.trackEnds=new Map();this.sealed=false;this.totalBytes=0;}
 append({kind,bytes,closedMonotonicNs}){
  if(this.sealed||this.entries.length>=MAX_FRAGMENTS||!/^\d{1,20}$/.test(closedMonotonicNs)||BigInt(closedMonotonicNs)<BigInt(this.entries.at(-1)?.closedMonotonicNs??this.session.startedMonotonicNs))fail('INVALID_FRAGMENT_ORDER');
  if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>MAX_FRAGMENT_BYTES||this.totalBytes+bytes.length>MAX_STREAM_BYTES)fail('FRAGMENT_SIZE_LIMIT');
  const sequence=this.entries.length;
  if(sequence===0){if(kind!=='INIT')fail('INIT_REQUIRED');this.tracks=trackInfo(bytes);if(this.session.audioRequired&&!this.tracks.some(t=>t.kind==='AUDIO'))fail('AUDIO_TRACK_REQUIRED');}
  else if(kind==='INIT'||this.entries.at(-1).kind==='FINAL_INDEX')fail('INVALID_FRAGMENT_ORDER');
  let detail={};
  if(kind==='MEDIA'){
   detail=mediaInfo(bytes,this.tracks);if(detail.fragmentSequence!==this.lastMediaSequence+1)fail('FRAGMENT_SEQUENCE_GAP');this.lastMediaSequence=detail.fragmentSequence;
   for(const t of detail.timing){const expected=this.trackEnds.get(t.trackId)??'0';if(t.decodeStartTicks!==expected)fail('TRACK_DECODE_GAP_OR_REORDER');this.trackEnds.set(t.trackId,t.decodeEndTicks);}
  }else if(kind==='FINAL_INDEX'){if(this.lastMediaSequence<1||mp4Boxes(bytes).length!==1||mp4Boxes(bytes)[0].type!=='mfra')fail('INVALID_FINAL_INDEX');}
  else if(kind!=='INIT')fail('INVALID_FRAGMENT_KIND');
  const record={schemaVersion:'packproof.encoded-fragment.v1',sessionDigest:this.sessionDigest,sequence,previousDigest:this.entries.at(-1)?.digest??null,kind,sha256:sha(bytes),byteLength:bytes.length,closedMonotonicNs,...detail};
  const entry={...record,digest:sha(canonicalize(record))};this.entries.push(entry);this.bytes.push(Buffer.from(bytes));this.totalBytes+=bytes.length;return entry;
 }
 seal(privateKey){
  if(this.sealed||this.entries.at(-1)?.kind!=='FINAL_INDEX'||this.tracks.some(t=>!this.trackEnds.has(t.trackId)))fail('INCOMPLETE_FRAGMENT_STREAM');
  this.sealed=true;const key=createPublicKey(privateKey);if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')fail('P256_KEY_REQUIRED');
  const record={schemaVersion:'packproof.fragment-manifest.v1',session:this.session,sessionDigest:this.sessionDigest,entryCount:this.entries.length,headDigest:this.entries.at(-1).digest,tracks:this.tracks,entries:this.entries,completeEncodedSha256:sha(Buffer.concat(this.bytes)),completeEncodedByteLength:this.bytes.reduce((n,b)=>n+b.length,0),coverage:'SOFTWARE_ENCODED_FRAGMENT_CHAIN',nativeCaptureAssurance:'UNSUPPORTED',sensorAttestation:'UNSUPPORTED'};
  const canonicalJson=canonicalize(record);return {canonicalJson,digest:sha(canonicalJson),signatureBase64:sign('sha256',Buffer.from(canonicalJson),privateKey).toString('base64')};
 }
}
/** Trusted public key must come from caller policy, never from the untrusted packet. */
export function verifyFragmentManifest(wrapper,encodedUnits,publicKey){
 if(!wrapper||typeof wrapper.canonicalJson!=='string'||wrapper.canonicalJson.length>4*1024*1024||sha(wrapper.canonicalJson)!==wrapper.digest||!Array.isArray(encodedUnits)||encodedUnits.length>MAX_FRAGMENTS)fail('FRAGMENT_MANIFEST_INVALID');
 const record=JSON.parse(wrapper.canonicalJson),key=createPublicKey(publicKey);
 if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1'||canonicalize(record)!==wrapper.canonicalJson||!verify('sha256',Buffer.from(wrapper.canonicalJson),key,Buffer.from(wrapper.signatureBase64,'base64')))fail('FRAGMENT_SIGNATURE_INVALID');
 if(record.schemaVersion!=='packproof.fragment-manifest.v1'||record.entryCount!==encodedUnits.length||record.entries?.length!==encodedUnits.length||record.coverage!=='SOFTWARE_ENCODED_FRAGMENT_CHAIN'||record.nativeCaptureAssurance!=='UNSUPPORTED'||record.sensorAttestation!=='UNSUPPORTED')fail('FRAGMENT_MANIFEST_BINDING');
 const journal=new FragmentJournal(record.session);
 encodedUnits.forEach((bytes,index)=>{const claimed=record.entries[index],actual=journal.append({kind:claimed.kind,bytes,closedMonotonicNs:claimed.closedMonotonicNs});if(canonicalize(actual)!==canonicalize(claimed))fail('FRAGMENT_BYTES_OR_CHAIN_MISMATCH');});
 if(journal.entries.at(-1)?.kind!=='FINAL_INDEX'||journal.tracks.some(t=>!journal.trackEnds.has(t.trackId))||record.headDigest!==journal.entries.at(-1).digest||record.sessionDigest!==journal.sessionDigest||canonicalize(record.tracks)!==canonicalize(journal.tracks)||record.completeEncodedSha256!==sha(Buffer.concat(encodedUnits))||record.completeEncodedByteLength!==encodedUnits.reduce((n,b)=>n+b.length,0))fail('FRAGMENT_INCOMPLETE_OR_REBOUND');
 return {valid:true,entryCount:record.entryCount,trackCount:record.tracks.length,audioCoverage:record.tracks.some(t=>t.kind==='AUDIO')?'ENCODED_BYTES_CHECKED':'NOT_PRESENT',byteCoverage:'COMPLETE_DECLARED_STREAM',chainCoverage:'SOFTWARE_ENCODED_FRAGMENT_CHAIN',nativeCaptureAssurance:'UNSUPPORTED',sensorAttestation:'UNSUPPORTED'};
}
export function nativeFragmentCapability(platform){
 if(!['android','ios'].includes(platform))fail('UNKNOWN_NATIVE_PLATFORM');
 return {schemaVersion:'packproof.fragment-capability.v1',platform,activeProfile:'FINAL_FILE_ONLY',incrementalFragments:'UNSUPPORTED',encoder:platform==='android'?'CameraX Recorder FileOutputOptions':'AVAssetWriter existing unfragmented MP4',safeFragmentClosureCallback:false,hardwareQualified:false,reason:platform==='android'?'Current recorder adapter exposes final file completion, not immutable encoded fragment completion.':'Existing writer configuration is unfragmented; encoder-safe fragment callback and recording continuity require a separate device spike.'};
}
