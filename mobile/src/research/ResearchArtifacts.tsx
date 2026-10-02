import {useEffect,useRef,useState} from 'react';
import {Image,Pressable,Text,View} from 'react-native';
import {useVideoPlayer,VideoView} from 'expo-video';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {toByteArray} from 'base64-js';
import type {AnalysisEnvelope,SourceRef} from '../../../packages/evidence-contracts/contracts.mjs';
import {usePackProof} from '../app/PackProofProvider';
import {useTheme} from '../theme/ThemeProvider';
import {Button} from '../ui/Button';
import {newIdempotencyKey} from '../v2-api';
import {derivativeReviewBinding,reviewArtifacts,type ReviewArtifact} from './review-model';

export function ResearchArtifacts({envelope,onSource}:{envelope:AnalysisEnvelope;onSource:(ref:SourceRef)=>void}) {
 return <View style={{gap:10}}>{reviewArtifacts(envelope).map(artifact=><Artifact key={artifact.sha256} envelope={envelope} artifact={artifact} onSource={onSource}/>)}</View>;
}
function Artifact({envelope,artifact,onSource}:{envelope:AnalysisEnvelope;artifact:ReviewArtifact;onSource:(ref:SourceRef)=>void}) {
 const app=usePackProof(),{colors}=useTheme(),alive=useRef(true),file=useRef<string|null>(null);
 const [uri,setUri]=useState<string|null>(null),[data,setData]=useState<Record<string,unknown>|null>(null),[viewed,setViewed]=useState(false),[approved,setApproved]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const binding=derivativeReviewBinding(envelope,artifact);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;if(file.current)void FileSystem.deleteAsync(file.current,{idempotent:true});};},[]);
 async function run(action:()=>Promise<void>){if(busy)return;setBusy(true);setError('');try{await app.ensureAuth();await action();}catch(e){if(alive.current)setError(e instanceof Error?e.message:'Artifact unavailable');}finally{if(alive.current)setBusy(false);}}
 async function preview(){
  if(!FileSystem.cacheDirectory)throw new Error('Preview storage unavailable');
  const suffix=artifact.mimeType.startsWith('video/')?'mp4':artifact.mimeType.startsWith('image/')?'png':'json';
  const destination=`${FileSystem.cacheDirectory}rnd-${envelope.analysisId}-${artifact.index}.${suffix}`;file.current=destination;
  const response=await FileSystem.downloadAsync(app.client.researchContentUrl(envelope.proofId,`/analyses/${envelope.analysisId}/artifacts/${artifact.index}`),destination,{headers:app.client.authorizedDownloadHeaders()});
  const info=await FileSystem.getInfoAsync(destination);
  if(response.status!==200||!info.exists||info.isDirectory||!('size' in info)||info.size!==artifact.byteLength)throw new Error('Artifact bytes do not match the committed length');
  const digest=sha256.create();for(let offset=0;offset<info.size;offset+=262144)digest.update(toByteArray(await FileSystem.readAsStringAsync(destination,{encoding:FileSystem.EncodingType.Base64,position:offset,length:Math.min(262144,info.size-offset)})));
  if(bytesToHex(digest.digest())!==artifact.sha256)throw new Error('Artifact hash verification failed');
  if(!alive.current){await FileSystem.deleteAsync(destination,{idempotent:true});return;}
  if(artifact.mimeType.includes('json')){setData(JSON.parse(await FileSystem.readAsStringAsync(destination)));setViewed(true);}setUri(destination);
 }
 async function approve(){if(!viewed||!binding)throw new Error('Preview the exact derivative before approval');await app.client.researchRequest(envelope.proofId,`/analyses/${envelope.analysisId}/review`,'POST',{approved:true,...binding},newIdempotencyKey());if(alive.current)setApproved(true);}
 async function exportReviewed(){
  if(!approved||!FileSystem.cacheDirectory||!(await Sharing.isAvailableAsync()))throw new Error('Approve this exact derivative before export');
  const destination=`${FileSystem.cacheDirectory}rnd-redacted-${envelope.analysisId}.zip`;
  try{const result=await FileSystem.downloadAsync(app.client.researchContentUrl(envelope.proofId,`/analyses/${envelope.analysisId}/export.zip`),destination,{headers:app.client.authorizedDownloadHeaders()});if(result.status!==200)throw new Error('Reviewed derivative export unavailable');if(alive.current)await Sharing.shareAsync(destination,{mimeType:'application/zip',dialogTitle:'Export reviewed derivative'});}finally{await FileSystem.deleteAsync(destination,{idempotent:true}).catch(()=>undefined);}
 }
 return <View style={{gap:8}}><Text style={{color:colors.textPrimary}}>{artifact.name} · {artifact.mimeType} · {artifact.byteLength} bytes</Text>
  <Button label="Preview committed artifact" variant="secondary" disabled={busy} onPress={()=>void run(preview)}/>
  {uri&&artifact.mimeType.startsWith('image/')?<Image source={{uri}} style={{width:'100%',height:260}} resizeMode="contain" accessibilityLabel="Exact redacted derivative" onLoad={()=>setViewed(true)} onError={()=>{setViewed(false);setError('Image preview unavailable; approval is disabled');}}/>:null}
  {uri&&artifact.mimeType.startsWith('video/')?<DerivativeVideo uri={uri} onViewed={()=>setViewed(true)}/>:null}
  {data?.schemaVersion==='packproof.sparse-geometry.v1'?<SparseProjection data={data} envelope={envelope} onSource={onSource}/>:data?<Text selectable style={{color:colors.textSecondary}}>{JSON.stringify(data,null,2)}</Text>:null}
  {binding?<><Text style={{color:colors.textSecondary}}>Inspect the derivative for missed sensitive details and obscured evidence. Approval binds this exact derivative and masking recipe; it does not certify complete redaction.</Text><Button label="Approve inspected derivative" disabled={busy||!viewed} onPress={()=>void run(approve)}/><Button label="Export reviewed derivative" variant="secondary" disabled={busy||!approved} onPress={()=>void run(exportReviewed)}/></>:null}
  {error?<Text accessibilityRole="alert" style={{color:colors.error}}>{error}</Text>:null}
 </View>;
}
function DerivativeVideo({uri,onViewed}:{uri:string;onViewed:()=>void}){
 const player=useVideoPlayer(uri,video=>{video.loop=false;});
 useEffect(()=>{const sub=player.addListener('statusChange',({status})=>{if(status==='readyToPlay')onViewed();});if(player.status==='readyToPlay')onViewed();return()=>sub.remove();},[player]);
 return <VideoView player={player} nativeControls allowsFullscreen contentFit="contain" style={{width:'100%',height:260}} accessibilityLabel="Exact derivative video for manual review"/>;
}
function SparseProjection({data,envelope,onSource}:{data:Record<string,unknown>;envelope:AnalysisEnvelope;onSource:(ref:SourceRef)=>void}){
 const {colors}=useTheme(),[plane,setPlane]=useState<'XY'|'XZ'|'YZ'>('XY'),[width,setWidth]=useState(280),[selected,setSelected]=useState<number|null>(null);
 type Point={xyz:number[];observations?:Array<{sourceRef?:{sourceId?:string}}>};
 const all=Array.isArray(data.points)?data.points.filter((point):point is Point=>!!point&&Array.isArray(point.xyz)&&point.xyz.length===3&&point.xyz.every(Number.isFinite)):[];
 const points=all.filter((_,index)=>index%Math.max(1,Math.ceil(all.length/500))===0).slice(0,500),axes=plane==='XY'?[0,1]:plane==='XZ'?[0,2]:[1,2];
 const min=axes.map(axis=>Math.min(...points.map(p=>p.xyz[axis]))),max=axes.map(axis=>Math.max(...points.map(p=>p.xyz[axis]))),extent=Math.max(max[0]-min[0],max[1]-min[1],1e-9);
 const sourceIds=selected===null?[]:[...new Set((points[selected]?.observations??[]).map(o=>o.sourceRef?.sourceId))];
 return <View style={{gap:8}}><Text style={{color:colors.textSecondary}}>Observed sparse geometry: {all.length} points; showing {points.length} in a 2D projection. Scale is unknown. Hidden surfaces remain unobserved.</Text><View style={{flexDirection:'row'}}>{(['XY','XZ','YZ'] as const).map(value=><Button key={value} label={`${plane===value?'Selected · ':''}${value}`} variant="tertiary" onPress={()=>setPlane(value)}/>)}</View>
 <View onLayout={event=>setWidth(event.nativeEvent.layout.width)} style={{height:260,backgroundColor:colors.surfaceElevated}} accessibilityLabel="Sparse observed point projection">{points.map((point,index)=><Pressable key={index} accessibilityRole="button" accessibilityLabel={`Inspect observed point ${index+1}`} onPress={()=>setSelected(index)} style={{position:'absolute',left:10+(point.xyz[axes[0]]-min[0])/extent*Math.max(1,width-20),top:250-(point.xyz[axes[1]]-min[1])/extent*240,width:selected===index?10:5,height:selected===index?10:5,borderRadius:5,backgroundColor:selected===index?colors.textPrimary:colors.accent}}/>)}</View>
 {sourceIds.map(id=>{const ref=envelope.sourceRefs.find(s=>s.sourceId===id);return ref?<Button key={id} label="Open point's supporting source" variant="tertiary" onPress={()=>onSource(ref)}/>:null;})}
 </View>;
}
