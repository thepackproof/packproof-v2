import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useEffect, useState } from 'react';
import { Text, View, Switch, Image } from 'react-native';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { Button } from '../ui/Button';
import { InfoCard } from '../ui/ProofCard';
import { recordSurfaceComparison } from '../capture';
import { isSurfaceResearchBuild, surfaceOptedIn, setSurfaceOptIn, savedSurfaceCaptures, uploadSurfaceCapture, requestSurfaceComparison, cacheSurfaceCapabilities } from './storage';
import type { SurfaceList, SurfaceStage } from './model';

export function SurfaceResearchConsent() {
  const app=usePackProof(),{colors}=useTheme();
  const [enabled,setEnabled]=useState(false),[error,setError]=useState<string|null>(null);
  useEffect(()=>{let active=true;if(app.session)void surfaceOptedIn(app.client.apiBaseUrl,app.session.userId).then(value=>{if(active)setEnabled(value);});return()=>{active=false;};},[app.client,app.session?.userId]);
  if(!isSurfaceResearchBuild()||!app.session)return null;
  return <InfoCard>
    <Text style={{color:colors.textPrimary,fontWeight:'600'}}>Experimental surface research</Text>
    <Text style={{color:colors.textSecondary}}>Opt in to save and upload a small set of package frames during normal recording. These may contain shipping details. Capture continues if surface analysis is unavailable. No camera profile has been qualified for identity findings.</Text>
    <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between'}}>
      <Text style={{color:colors.textPrimary}}>Collect research frames</Text>
      <Switch accessibilityLabel="Opt in to experimental surface collection" value={enabled} onValueChange={value=>{
        void setSurfaceOptIn(app.client.apiBaseUrl,app.session!.userId,value).then(()=>{setEnabled(value);setError(null);}).catch(()=>setError('Your preference could not be saved.'));
      }}/>
    </View>
    <Text style={{color:colors.textSecondary}}>Turning this off stops future collection. Saved originals remain available for recovery. The research server must also enable collection.</Text>
    {error?<Text accessibilityRole="alert" style={{color:colors.error}}>{error}</Text>:null}
  </InfoCard>;
}

const stages:Array<{value:SurfaceStage;label:string}>=[{value:'unknown',label:'Stage unknown'},{value:'before_opening',label:'Before opening'},{value:'during_unpacking',label:'During unpacking'},{value:'after_opening',label:'After opening'}];
function resultTitle(value:unknown):string { return value === 'unsupported' || value === 'inconclusive' ? 'Unable to compare' : human(value); }
function human(value:unknown):string{return typeof value==='string'?value.replace(/_/g,' ').replace(/^./,c=>c.toUpperCase()):'Not checked';}

export function SurfaceResearchPanel({proofId,trackingNumber}:{proofId:string;trackingNumber:string|null|undefined}){
  const app=usePackProof(),{colors}=useTheme();
  const [summary,setSummary]=useState<SurfaceList|null>(null),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),[busy,setBusy]=useState(false);
  const [stage,setStage]=useState<SurfaceStage>('unknown'),[enrollmentId,setEnrollmentId]=useState<string|null>(null),[details,setDetails]=useState(false);
  const [saved,setSaved]=useState<Awaited<ReturnType<typeof savedSurfaceCaptures>>>([]);
  const reload=async()=>{
    if(!app.session)return;
    await app.ensureAuth();
    const [data,local]=await Promise.all([app.client.surfaceRequest<SurfaceList>(proofId),savedSurfaceCaptures(app.client.apiBaseUrl,app.session.userId,proofId)]);
    cacheSurfaceCapabilities(app.client.apiBaseUrl,app.session.userId,proofId,data,trackingNumber??'');
    setSummary(data);setSaved(local);setEnrollmentId(current=>data.enrollments.some(e=>e.id===current)?current:data.enrollments[0]?.id??null);
  };
  useEffect(()=>{if(isSurfaceResearchBuild())void reload().catch(e=>setError(e instanceof Error?e.message:'Experimental comparison is unavailable.'));},[proofId,app.session?.userId]);
  if(!isSurfaceResearchBuild()||!app.session)return null;
  const run=(task:()=>Promise<void>)=>{setBusy(true);setError(null);setNotice(null);void task().catch(e=>setError(e instanceof Error?e.message:'Surface research could not finish. Originals are kept.')).finally(()=>setBusy(false));};
  const compare=async()=>{
    if(!enrollmentId)throw new Error('A sender enrollment is needed before a later comparison.');
    if(!trackingNumber)throw new Error('This Proof needs an expected tracking number before a surface observation can be associated.');
    await reload(); // Explicit comparison refreshes permission before opening its optional camera.
    const enrollment=summary?.enrollments.find(e=>e.id===enrollmentId);
    const observationId=await recordSurfaceComparison({client:app.client,userId:app.session!.userId,proofId,enrollmentId,expectedTracking:trackingNumber,
      contextStage:stage,shipmentLegId:enrollment?.shipmentLegId==='RETURN'?'RETURN':'OUTBOUND'});
    if(observationId&&summary?.capabilities.internalComparison){await requestSurfaceComparison(app.client,proofId,enrollmentId,observationId);setNotice('Observation saved. Experimental comparison requested.');}
    else setNotice(observationId?'Observation saved. Internal comparison is disabled.':'No usable surface observation was uploaded. Your local originals are kept.');
    await reload();
  };
  const exportResearch=async()=>{
    await app.ensureAuth();
    const exported=await app.client.surfaceRequest(proofId,'/export');
    if(!FileSystem.cacheDirectory)throw new Error('Export storage is unavailable.');
    const file=`${FileSystem.cacheDirectory}${proofId.replace(/[^A-Za-z0-9_-]/g,'_')}-surface-research.json`;
    await FileSystem.writeAsStringAsync(file,JSON.stringify(exported,null,2));
    if(!await Sharing.isAvailableAsync())throw new Error('Sharing is unavailable on this device. Open the web viewer to download the research export.');
    await Sharing.shareAsync(file,{mimeType:'application/json',UTI:'public.json',dialogTitle:'Export experimental surface evidence'});
    setNotice('Export prepared. Original image bytes are separate; this JSON contains commitments and source references.');
  };
  return <InfoCard>
    <Text style={{color:colors.textPrimary,fontWeight:'600'}}>Package surfaces · experimental</Text>
    <Text style={{color:colors.textSecondary}}>Surface comparison is unqualified research. It does not establish unchanged seals, custody, or contents.</Text>
    <Text style={{color:colors.textSecondary}}>{summary?.capabilities.collection?'Research collection enabled':'Collection unavailable'} · {summary?.enrollments.length??0} enrolled · {summary?.observations.length??0} later observations</Text>
    {summary?.enrollments.length? <>
      {summary.enrollments.map(enrollment=><Button key={enrollment.id} variant={enrollmentId===enrollment.id?'secondary':'tertiary'} label={`${enrollmentId===enrollment.id?'Selected: ':''}${enrollment.shipmentLegId==='RETURN'?'Return':'Outbound'} enrollment`} onPress={()=>setEnrollmentId(enrollment.id)} disabled={busy}/>)}
      <Text style={{color:colors.textSecondary}}>When is this observation? This is your statement, not a camera-verified fact.</Text>
      <View style={{gap:4}}>{stages.map(option=><Button key={option.value} variant={stage===option.value?'secondary':'tertiary'} label={`${stage===option.value?'• ':''}${option.label}`} onPress={()=>setStage(option.value)} disabled={busy}/>)}</View>
      <Button label="Compare package" loading={busy} disabled={!summary.capabilities.collection} onPress={()=>run(compare)}/>
      <Text style={{color:colors.textSecondary}}>Participation is optional and free. This opens a live view; tracking updates cannot compare a physical package. Server receipt records when files arrive, not when the camera observed the scene.</Text>
    </>:<Text style={{color:colors.textSecondary}}>Not checked. Opt in under Account, then record normal packing to collect a candidate enrollment.</Text>}
    {summary?.comparisons.map(comparison=>{
      const result=comparison.result&&typeof comparison.result==='object'?comparison.result as Record<string,unknown>:{};
      const scoped=result.scopeResults&&typeof result.scopeResults==='object'?result.scopeResults as Record<string,{status?:string;reasons?:string[]}>:{};
      return <View key={comparison.id} style={{gap:4}}>
        <Text style={{color:colors.textPrimary,fontWeight:'600'}}>{resultTitle(result.status??comparison.status??comparison.state)}</Text>
        <Text style={{color:colors.textSecondary}}>Label: {human(scoped.label?.status)} · Carton: {human(scoped.carton?.status)} · Assembly: {human(scoped.assembly?.status)}</Text>
        {Object.entries(scoped).map(([scope,value])=><Text key={scope} style={{color:colors.textSecondary}}>{human(scope)}: {value.reasons?.join('; ')||'No additional reasons provided.'}</Text>)}
        {result.coverage&&typeof result.coverage==='object'?Object.entries(result.coverage as Record<string,Record<string,unknown>>).map(([group,coverage])=><Text key={group} style={{color:colors.textSecondary}}>{human(group)} coverage: {human(coverage.state)} · {String(coverage.comparedRegions??0)} compared regions</Text>):null}
        <Text style={{color:colors.textSecondary}}>Profile unqualified. A partial observation cannot verify the whole package.</Text>
      </View>;
    })}
    {saved.filter(item=>!item.recordId).map(item=><View key={item.id} style={{gap:4}}>
      <Text style={{color:colors.textSecondary}}>{item.notice??'Research originals saved on this device; upload pending.'}</Text>
      <Button label="Retry saved research upload" variant="secondary" disabled={busy} onPress={()=>run(async()=>{
        await app.ensureAuth();await uploadSurfaceCapture(app.client,app.session!.userId,item.id);await reload();
      })}/>
    </View>)}
    {notice?<Text accessibilityLiveRegion="polite" style={{color:colors.textSecondary}}>{notice}</Text>:null}
    {error?<Text accessibilityRole="alert" style={{color:colors.error}}>{error}</Text>:null}
    <Button label="Refresh surface research" variant="tertiary" disabled={busy} onPress={()=>run(reload)}/>
    <Button label="Export research evidence JSON" variant="secondary" disabled={busy||!summary} onPress={()=>run(exportResearch)}/>
    <Button label={details?'Hide research record':'Source and method details'} variant="tertiary" onPress={()=>setDetails(!details)}/>
    {details?(summary?.enrollments??[]).concat(summary?.observations??[]).map(record=>{
      const sources=Array.isArray(record.sourceDigests)?record.sourceDigests as Array<{sourceId:string;sha256:string;frameTimeMs:number|null}>:[];
      return <View key={record.id} style={{gap:8}}><Text style={{color:colors.textPrimary}}>{record.kind==='observation'?'Later observation':'Enrollment'} sources</Text>{sources.map(source=><View key={source.sourceId}>
        <Image source={app.client.surfaceMediaSource(proofId,source.sourceId)} style={{width:'100%',height:220}} resizeMode="contain" accessibilityLabel="Preserved full surface frame; selected regions are recorded in the source details"/>
        <Text selectable style={{color:colors.textSecondary,fontSize:11}}>Source {source.sourceId} · {source.frameTimeMs??'Unknown'} ms · SHA-256 {source.sha256}</Text>
      </View>)}</View>;
    }):null}
    {details?<Text selectable style={{color:colors.textSecondary,fontSize:12}}>{JSON.stringify(summary,null,2)}</Text>:null}
  </InfoCard>;
}
