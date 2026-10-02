import * as FileSystem from 'expo-file-system';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {toByteArray} from 'base64-js';
import type {LocalCapture} from '../capture';
import type {PackProofV2Client} from '../v2-api';
import {nativeSidecarFiles,SIDECAR_CHUNK_BYTES,SIDECAR_MAX_BYTES} from './sidecar-policy';

/** Upload durable files after core completion; no live camera buffers traverse this path. */
export async function uploadNativeSidecars(client:PackProofV2Client,capture:LocalCapture,persist:()=>Promise<void>) {
 const research=capture.research;
 if(!research?.signed||!research.receipt||!capture.captureSessionId||!capture.captureProofId||!capture.captureUserId||!FileSystem.documentDirectory||!/^cap_[A-Za-z0-9_-]{1,91}$/.test(capture.captureSessionId))return;
 const directory=`${FileSystem.documentDirectory}packproof-captures/${capture.captureSessionId}/`;
 const signed=JSON.parse(research.signed.canonicalJson) as {acquisitionSha256:string|null;journalSha256:string|null};
 let acquisition:unknown=null;
 if(signed.acquisitionSha256){const json=await FileSystem.readAsStringAsync(`${directory}research-acquisition.json`);if(bytesToHex(sha256(json))!==signed.acquisitionSha256)throw new Error('Native metadata changed after signing');acquisition=JSON.parse(json);}
 const files=nativeSidecarFiles(signed,acquisition);
 research.sidecars??={state:'PENDING',receipts:{}};
 for(const file of files){
  if(research.sidecars.receipts[file.fileName])continue;
  client.assertCaptureAccount(capture.captureUserId,client.apiBaseUrl);
  const uri=directory+file.fileName,info=await FileSystem.getInfoAsync(uri);
  if(!info.exists||info.isDirectory||!('size' in info)||info.size<1||info.size>SIDECAR_MAX_BYTES||file.byteLength!==undefined&&file.byteLength!==info.size)throw new Error('Native sidecar is missing or outside its byte commitment');
  const partCount=Math.ceil(info.size/SIDECAR_CHUNK_BYTES),digest=sha256.create();
  // Verify the full local file before beginning bounded transport.
  for(let index=0;index<partCount;index++){const encoded=await FileSystem.readAsStringAsync(uri,{encoding:FileSystem.EncodingType.Base64,position:index*SIDECAR_CHUNK_BYTES,length:Math.min(SIDECAR_CHUNK_BYTES,info.size-index*SIDECAR_CHUNK_BYTES)});digest.update(toByteArray(encoded));}
  if(bytesToHex(digest.digest())!==file.sha256)throw new Error('Native sidecar changed after signing');
  for(let partIndex=0;partIndex<partCount;partIndex++){
   client.assertCaptureAccount(capture.captureUserId,client.apiBaseUrl);
   const dataBase64=await FileSystem.readAsStringAsync(uri,{encoding:FileSystem.EncodingType.Base64,position:partIndex*SIDECAR_CHUNK_BYTES,length:Math.min(SIDECAR_CHUNK_BYTES,info.size-partIndex*SIDECAR_CHUNK_BYTES)});
   const response=await client.researchRequest<{state:string;digest?:string;sidecar?:unknown}>(capture.captureProofId,`/capture-intents/${research.intentId}/sidecars/${file.fileName}`,'POST',{partIndex,partCount,byteLength:info.size,sha256:file.sha256,dataBase64},`${capture.captureSessionId}:${file.fileName}:${partIndex}`);
   if(response.state==='RECEIVED'){research.sidecars.receipts[file.fileName]=response;await persist();break;}
  }
  if(!research.sidecars.receipts[file.fileName])throw new Error('Sidecar receipt pending');
 }
 research.sidecars.state='RECEIVED';await persist();
}
