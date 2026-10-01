import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import { bindNativeSurfaceContext, isSurfaceSamplerAvailable, readNativeSurfaceJournal, inspectNativeSurfaceSource } from '../../modules/packproof-unified-camera';
import { newIdempotencyKey, type PackProofV2Client, type UploadTarget } from '../v2-api';
import { canonical, digest, parseSurfaceJournal, sourceBarcodePolygon, sourceRegions, surfaceCollectionAllowed, type SurfaceBinding, type SurfaceList, type SurfaceStage } from './model';

export const isSurfaceResearchBuild = () => process.env.EXPO_PUBLIC_PACKPROOF_RND_BUILD === 'true' && process.env.EXPO_PUBLIC_PACKPROOF_FINGERPRINT_ENABLED === 'true';
const optInKey = (api: string, user: string) => `surface-rnd-opt-in:${digest(`${api.replace(/\/+$/,'')}|${user}`)}`;
export async function surfaceOptedIn(api: string, user: string): Promise<boolean> { return (await AsyncStorage.getItem(optInKey(api,user))) === '1'; }
export async function setSurfaceOptIn(api: string, user: string, enabled: boolean): Promise<void> { await AsyncStorage.setItem(optInKey(api,user),enabled ? '1' : '0'); }
const root = () => { if (!FileSystem.documentDirectory) throw new Error('Device storage is unavailable.'); return `${FileSystem.documentDirectory}packproof-captures/`; };
const directory = (id: string) => { if (!/^cap_[A-Za-z0-9_-]{1,91}$/.test(id)) throw new Error('Invalid surface capture identity.'); return `${root()}${id}/`; };
type CapabilityCache = { summary: SurfaceList; expectedTracking: string; observedAt: number };
const capabilities = new Map<string, CapabilityCache>();
const capabilityKey = (api: string, user: string, proof: string) => `${api}|${user}|${proof}`;
export function cacheSurfaceCapabilities(api: string, user: string, proof: string, summary: SurfaceList, expectedTracking: string) {
  if (capabilities.size > 100) capabilities.clear();
  capabilities.set(capabilityKey(api,user,proof),{summary,expectedTracking,observedAt:Date.now()});
}
async function boundedOptIn(api: string, user: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([surfaceOptedIn(api,user),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),750);})]); }
  finally { if(timer)clearTimeout(timer); }
}
type Recovery = { sourceVideo?: { sha256: string; byteSize: number; provenance: 'NATIVE_HASH' | 'COMMITTED_CORE_EVIDENCE'; evidenceId?: string }; binding: SurfaceBinding; commandKey: string; sources: Record<string,{key: string; sourceId?: string; committed?: boolean}>; command?: Record<string,unknown>; intent?:{intentId:string;expiresAt:string}; recordId?: string; notice?:string; };
let writing = Promise.resolve();
async function save(state: Recovery) {
  const snapshot=JSON.stringify(state);
  const write=writing.catch(()=>undefined).then(async()=>{
    const path=directory(state.binding.captureSessionId);
    await FileSystem.makeDirectoryAsync(path,{intermediates:true});
    await FileSystem.writeAsStringAsync(`${path}surface-upload.next.json`,snapshot);
    await FileSystem.moveAsync({from:`${path}surface-upload.next.json`,to:`${path}surface-upload.json`});
  });
  writing=write;await write;
}
async function read(id: string):Promise<Recovery>{ return JSON.parse(await FileSystem.readAsStringAsync(`${directory(id)}surface-upload.json`)); }

/** Failures here are optional feature failures; the existing recording always proceeds. */
export async function prepareSurfaceCollection(client: PackProofV2Client, input: {
  proofId:string;userId:string;captureSessionId:string;expectedTracking?:string;
  operation?:'enrollment'|'observation';enrollmentId?:string;shipmentLegId?:'OUTBOUND'|'RETURN';contextStage?:SurfaceStage;
}):Promise<boolean>{
  if(!isSurfaceResearchBuild() || !isSurfaceSamplerAvailable() || !await boundedOptIn(client.apiBaseUrl,input.userId))return false;
  client.assertCaptureAccount(input.userId,client.apiBaseUrl);
  // Proof loading primes a short-lived account-bound capability cache. Never add network waits to Record.
  const cached=capabilities.get(capabilityKey(client.apiBaseUrl,input.userId,input.proofId));
  if(!cached||Date.now()-cached.observedAt>120_000)return false;
  if(!surfaceCollectionAllowed(true,true,true,cached.summary.capabilities.collection,true))return false;
  const expected=input.expectedTracking ?? cached.expectedTracking;
  const binding:SurfaceBinding={experimental:true,schemaVersion:'surface-local/1',captureSessionId:input.captureSessionId,
    proofId:input.proofId,userId:input.userId,apiBaseUrl:client.apiBaseUrl,expectedTracking:expected,
    operation:input.operation??'enrollment',...(input.enrollmentId?{enrollmentId:input.enrollmentId}:{}),shipmentLegId:input.shipmentLegId??'OUTBOUND',
    contextStage:input.contextStage??'unknown',authorizationAt:new Date().toISOString(),qualification:'UNQUALIFIED',platform:Platform.OS,osVersion:String(Platform.Version)};
  await save({binding,commandKey:newIdempotencyKey(),sources:{}});
  await bindNativeSurfaceContext(input.captureSessionId,canonical(binding));
  return true;
}

const checkpointing=new Map<string,Promise<void>>();
export function checkpointSurfaceVideo(client:PackProofV2Client,userId:string,id:string):Promise<void>{
  if(!isSurfaceResearchBuild())return Promise.resolve();
  const scope=`${client.apiBaseUrl}|${userId}|${id}`;
  const existing=checkpointing.get(scope);if(existing)return existing;
  const task=(async()=>{
    const state=await read(id);
    if(state.binding.userId!==userId||state.binding.apiBaseUrl!==client.apiBaseUrl)throw new Error('Original capture account required.');
    if(!state.sourceVideo){state.sourceVideo={...await inspectNativeSurfaceSource(id,'video.mp4'),provenance:'NATIVE_HASH'};await save(state);}
  })().finally(()=>checkpointing.delete(scope));
  checkpointing.set(scope,task);return task;
}

const uploading=new Map<string,Promise<string|null>>();
export function uploadSurfaceCapture(client:PackProofV2Client,userId:string,id:string):Promise<string|null>{
  const scope=`${client.apiBaseUrl}|${userId}|${id}`;
  const existing=uploading.get(scope);if(existing)return existing;
  const task=uploadInner(client,userId,id).finally(()=>uploading.delete(scope));uploading.set(scope,task);return task;
}
async function uploadInner(client:PackProofV2Client,userId:string,id:string):Promise<string|null>{
  if(!isSurfaceResearchBuild())return null;
  await checkpointing.get(`${client.apiBaseUrl}|${userId}|${id}`)?.catch(()=>undefined);
  const state=await read(id);
  if(state.binding.userId!==userId||state.binding.apiBaseUrl!==client.apiBaseUrl)throw new Error('Open these surface originals in their original account and server.');
  client.assertCaptureAccount(userId,state.binding.apiBaseUrl);
  if(state.recordId)return state.recordId;
  let journal=parseSurfaceJournal(await readNativeSurfaceJournal(id));
  for(let attempt=0;!journal.finished&&attempt<10;attempt++){
    await new Promise(resolve=>setTimeout(resolve,200));
    journal=parseSurfaceJournal(await readNativeSurfaceJournal(id));
  }
  if(canonical(journal.binding)!==canonical(state.binding))throw new Error('Surface capture binding changed. Originals are kept.');
  if(!journal.finished)throw new Error('Surface capture has no completion journal. Originals are kept for research inspection.');
  if(journal.interrupted)throw new Error('The capture was interrupted. Surface identity is unavailable; originals remain on this device.');
  if(!journal.sources.length){state.notice=journal.unavailable.join(', ')||'No usable physical detail was passively selected.';await save(state);return null;}
  // Preserve the video commitment before optional image uploads. Core cleanup is free to remove its
  // already-committed local movie later; the fingerprint sidecar must not depend on that local file.
  if(!state.sourceVideo){
    const videoInfo=await FileSystem.getInfoAsync(`${directory(id)}video.mp4`);
    if(videoInfo.exists)state.sourceVideo={...await inspectNativeSurfaceSource(id,'video.mp4'),provenance:'NATIVE_HASH'};
    else if(state.binding.operation==='enrollment'){
      const proof=await client.getProof(state.binding.proofId);
      const originals=proof.evidence.filter(evidence=>evidence.captureSessionId===id&&evidence.validationStatus==='COMMITTED'&&evidence.sha256&&evidence.byteSize);
      if(originals.length!==1)throw new Error('The source movie commitment is unavailable. Surface originals remain saved.');
      state.sourceVideo={sha256:originals[0].sha256!,byteSize:originals[0].byteSize!,provenance:'COMMITTED_CORE_EVIDENCE',evidenceId:originals[0].evidenceId};
    }else throw new Error('The local observation video is unavailable. Surface originals remain saved.');
    await save(state);
  }
  const sources:Array<{sourceId:string;sha256:string;frameTimeMs:number}>=[],regions:Array<Record<string,unknown>>=[];
  for(const [index,source] of journal.sources.entries()){
    const uri=`${directory(id)}${source.fileName}`;
    const info=await FileSystem.getInfoAsync(uri);
    if(!info.exists||!('size'in info)||info.size!==source.byteSize)throw new Error('A selected original is unavailable. Keep the remaining local files.');
    // Hash native bytes and stream the upload. JavaScript receives only metadata.
    const inspected=await inspectNativeSurfaceSource(id,source.fileName);
    if(inspected.sha256!==source.sha256||inspected.byteSize!==source.byteSize)throw new Error('Selected original hash changed. Upload stopped.');
    const item=state.sources[source.fileName]??={key:newIdempotencyKey()};await save(state);
    client.assertCaptureAccount(userId,state.binding.apiBaseUrl);
    const target=await client.surfaceRequest<{sourceId:string;committed:boolean;upload:UploadTarget}>(state.binding.proofId,'/media','POST',{
      captureSessionId:state.binding.operation==='observation'?null:id,contentType:'image/jpeg',byteSize:source.byteSize,sha256:source.sha256,
    },item.key);
    if(item.sourceId&&item.sourceId!==target.sourceId)throw new Error('Surface upload identity changed.');
    item.sourceId=target.sourceId;await save(state);
    if(!target.committed){
      const upload=client.surfaceUploadTarget(state.binding.proofId,target.upload);
      const result=await FileSystem.uploadAsync(upload.url,uri,{httpMethod:'PUT',uploadType:FileSystem.FileSystemUploadType.BINARY_CONTENT,headers:upload.headers});
      if(result.status<200||result.status>=300)throw new Error('Surface originals are saved locally. Retry uploading after reconnecting.');
    }
    item.committed=true;await save(state);
    sources.push({sourceId:target.sourceId,sha256:source.sha256,frameTimeMs:source.frameTimeMs});
    regions.push(...sourceRegions(target.sourceId,index,source));
  }
  const sourceVideo=state.sourceVideo;
  const command:Record<string,unknown>={schemaVersion:'surface-command/1',captureSessionId:state.binding.operation==='observation'?null:id,
    shipmentLegId:state.binding.shipmentLegId,captureMode:'live',contextStage:state.binding.contextStage,captureProfileId:journal.profileId,
    deviceMetadata:{nativeCaptureSessionId:id,platform:state.binding.platform??'unavailable',osVersion:state.binding.osVersion??'unavailable',nativeJournalSha256:journal.root,sourceVideoFile:'video.mp4',sourceVideoSha256:sourceVideo.sha256,sourceVideoByteSize:sourceVideo.byteSize,sourceVideoCommitmentProvenance:sourceVideo.provenance,...(sourceVideo.evidenceId?{sourceVideoEvidenceId:sourceVideo.evidenceId}:{}),
      closureState:'UNKNOWN',association:'EXPECTED_BARCODE_ONLY',scopeLimitations:['No independently identified carton regions','Print process unknown','Camera profile unqualified'],
      frames:journal.sources.map(({fileName,...metadata})=>({...metadata,fileName})),regionHints:sources.map((source,index)=>({sourceId:source.sourceId,barcodePolygon:sourceBarcodePolygon(journal.sources[index]),printProcess:'unknown',association:'same_frame_expected_barcode'})),unavailable:journal.unavailable},
    continuityEvents:journal.continuityEvents.slice(-100),sources,regions,
    ...(state.binding.operation==='observation'?{enrollmentId:state.binding.enrollmentId}:{})};
  if(state.command&&canonical(command)!==canonical(state.command))throw new Error('The frozen surface command changed.');
  state.command=command;await save(state);
  if(!state.intent||Date.parse(state.intent.expiresAt)<=Date.now()+5000){
    state.intent=await client.surfaceRequest(state.binding.proofId,'/intents','POST',{operation:state.binding.operation,requestDigest:digest(canonical(command))});await save(state);
  }
  client.assertCaptureAccount(userId,state.binding.apiBaseUrl);
  const record=await client.surfaceRequest<{id:string}>(state.binding.proofId,state.binding.operation==='enrollment'?'/enrollments':'/observations','POST',{...command,intentId:state.intent!.intentId},state.commandKey);
  state.recordId=record.id;await save(state);return record.id;
}

export async function savedSurfaceCaptures(api:string,userId:string,proofId?:string):Promise<Array<{id:string;recordId?:string;notice?:string;operation:string}>>{
  if(!isSurfaceResearchBuild()||!(await FileSystem.getInfoAsync(root())).exists)return [];
  const result=[];
  for(const id of (await FileSystem.readDirectoryAsync(root())).filter(id=>/^cap_[A-Za-z0-9_-]{1,91}$/.test(id))){
    try{const state=await read(id);if(state.binding.userId===userId&&state.binding.apiBaseUrl===api&&(!proofId||state.binding.proofId===proofId))result.push({id,recordId:state.recordId,notice:state.notice,operation:state.binding.operation});}catch{/* Unrelated ordinary recording or interrupted metadata write. */}
  }
  return result;
}

export async function requestSurfaceComparison(client:PackProofV2Client,proofId:string,enrollmentId:string,observationId:string):Promise<void>{
  const command={schemaVersion:'surface-command/1',enrollmentId,observationId,requestedScope:'assembly'};
  // Deterministic request key prevents a lost response creating another comparison attempt.
  const key=`surface_${digest(canonical(command))}`;
  const intent=await client.surfaceRequest<{intentId:string}>(proofId,'/intents','POST',{operation:'comparison',requestDigest:digest(canonical(command))});
  await client.surfaceRequest(proofId,'/comparisons','POST',{...command,intentId:intent.intentId},key);
}
