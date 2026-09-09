import {getAttestationAvailability} from "../attestation/native";
import * as FileSystem from 'expo-file-system';
import { sha256 } from '@noble/hashes/sha256';
import { toByteArray } from 'base64-js';
import { canonical, chainSegment, createManifest, manifestDigest, CORE_VERSION, type CapabilitySnapshot, type CaptureContext, type Observation } from '../../../backend/src/capture/core';
import { bindNativeCaptureContext, readNativeCaptureJournal, isNativeCaptureEngineAvailable } from '../../modules/packproof-unified-camera';
import type {PackProofV2Client} from '../v2-api';
import {persistCaptureMetadata,type LocalCapture} from '../capture';
const hex=(bytes:Uint8Array)=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const hash=async(text:string)=>hex(sha256(text));
export const captureEngineEnabled=()=>process.env.EXPO_PUBLIC_PACKPROOF_CAPTURE_ENGINE==='1';
export async function beginNativeEngine(client:PackProofV2Client,proofId:string|undefined,launchToken?:string) {
  if(!isNativeCaptureEngineAvailable())throw new Error('Install the current Android capture build before opening this link.');
  const capabilities:CapabilitySnapshot={surface:'ANDROID',cameraSource:'INTEGRATED',timing:'ENCODER_PROGRESS',barcode:true,itemVisibility:false,durableJournal:true,incrementalMedia:false,audio:false,deviceAuthentication:(await getAttestationAvailability()).available?'ANDROID_BIOMETRIC_STRONG':'UNAVAILABLE',appIntegrity:'UNAVAILABLE',storageReserveBytes:await FileSystem.getFreeDiskStorageAsync(),coreVersion:CORE_VERSION};
  const intent=launchToken?{launchToken}:await client.captureEngineRequest<{launchToken:string}>('/capture-intents','POST',{proofId,allowedSurfaces:['ANDROID']});
  const result=await client.captureEngineRequest<{session:{id:string;proofId:string;policyVersion:string;state:string;expiresAt:string;recoverUntil:string};context:CaptureContext}>('/capture-sessions/bind','POST',{launchToken:intent.launchToken,capabilities});
  if((proofId!==undefined&&result.context.proofId!==proofId)||result.context.captureId!==result.session.id)throw new Error('The capture link belongs to another order.');
  await bindNativeCaptureContext(result.session.id,result.context.proofId,canonical(result.context));
  return {...result.session,captureContext:result.context};
}
export async function sealNativeEngine(client:PackProofV2Client,capture:LocalCapture):Promise<void> {
  const context=capture.captureContext;if(!context)return;
  if(context.proofId!==capture.captureProofId||context.captureId!==capture.captureSessionId||context.actorId!==capture.captureUserId)throw new Error('Open this recording in its original account and order.');
  if(!capture.captureSha256||!capture.byteSize||!capture.durationMs)throw new Error('The original recording must be preserved before confirmation.');
  if(capture.captureManifestSha256)return; // Immutable server seal; byte hash is rechecked by normal capture registration.
  const journal=await readNativeCaptureJournal(context.captureId);const observations:Observation[]=[];let previous:string|null=null;let sequence=0;
  for(const line of journal.split('\n').filter(Boolean)){
    const row=JSON.parse(line);const event=row.event;
    if(event.sequence!==sequence++||event.previous!==previous||await hash(JSON.stringify(event))!==row.sha256)throw new Error('The saved capture journal failed its integrity check. Keep the original.');
    previous=row.sha256;const type=event.type;
    if(!['CAPTURE_STARTED','CAPTURE_ENDED','INTERRUPTION','LABEL'].includes(type))throw new Error('The saved capture journal is unsupported.');
    if(type==='LABEL'&&!/^[A-Z0-9]{10,64}$/.test(event.value))continue;
    const time=Math.min(Math.floor(capture.durationMs),Math.max(0,Math.floor(event.mediaTimeMs)));
    observations.push({id:`native:${event.sequence}`,captureId:context.captureId,type,startMs:time,endMs:time,
      source:type==='LABEL'?'LIVE_ANALYSIS':'DEVICE',model:type==='LABEL'?{id:'mlkit-barcode',version:'17.2.0',configuration:'tracking-2-frame-consensus',calibration:'NOT_CALIBRATED'}:null,
      confidence:null,value:event.value,timePrecision:'APPROXIMATE'});
  }
  if(!observations.some(o=>o.type==='CAPTURE_ENDED'))throw new Error('This capture did not finish its native journal. Keep the original recording.');
  const segments=[];let previousSegment:string|null=null;const size=4*1024*1024;
  for(let offset=0;offset<capture.byteSize;offset+=size){
    const length=Math.min(size,capture.byteSize-offset);const bytes=toByteArray(await FileSystem.readAsStringAsync(capture.uri,{encoding:FileSystem.EncodingType.Base64,position:offset,length}));
    const segment=await chainSegment({sequence:segments.length,offsetBytes:offset,byteSize:length,sha256:hex(sha256(bytes)),previous:previousSegment,startMs:0,endMs:Math.floor(capture.durationMs),timing:'WHOLE_RECORDING'},hash);
    segments.push(segment);previousSegment=segment.commitment;
  }
  const source={sha256:capture.captureSha256,byteSize:capture.byteSize,contentType:capture.contentType,durationMs:Math.floor(capture.durationMs)};
  const manifest=await createManifest(context,source,segments,observations,hash);const digest=await manifestDigest(manifest,hash);
  // Persist the exact local root before any request that could lose its response.
  capture.captureManifest=manifest;
  await persistCaptureMetadata(capture);
  await client.captureEngineRequest(`/capture-sessions/${encodeURIComponent(context.captureId)}/seal`,'POST',{source,segments,observations,sha256:digest});
  capture.captureManifestSha256=digest;
}
