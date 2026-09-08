import {useEffect,useState} from 'react';
import {Pressable,Text,View} from 'react-native';
import {usePackProof} from '../app/PackProofProvider';
import {newStudyOperationNonce} from '../../modules/packproof-unified-camera';
import {rememberNativeStudyConsent,flushNativeStudyTimings,type NativeStudyStatus} from '../analytics/native-study';
import {useTheme} from '../theme/ThemeProvider';
import {Button} from './Button';
import {InfoCard} from './ProofCard';
export function StudyConsentCard(){
  const app=usePackProof(),{colors}=useTheme();const userId=app.session?.userId;
  const [deviceClass,setDeviceClass]=useState<'s24_ultra'|'a16_5g'|'other_android'>('other_android');
  const [status,setStatus]=useState<NativeStudyStatus|null>(null),[checked,setChecked]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  useEffect(()=>{let active=true;setStatus(null);setChecked(false);if(userId)void app.client.studyRequest<NativeStudyStatus>('/consent').then(async value=>{if(!active)return;setStatus(value);await rememberNativeStudyConsent(app.client,userId,value);}).catch(()=>{});return()=>{active=false;};},[app.client,userId]);
  if(!status?.enabled||!status.datasetRef||!userId)return null;
  const save=async(decision:'grant'|'withdraw')=>{setBusy(true);setError(null);try{
    const result=await app.client.studyRequest<NativeStudyStatus>('/consent','POST',{datasetRef:status.datasetRef,operationNonce:newStudyOperationNonce(),decision,statementVersion:status.statementVersion});
    const value={...result,enabled:true};await rememberNativeStudyConsent(app.client,userId,value,deviceClass);setStatus(value);setChecked(false);if(decision==='withdraw')await flushNativeStudyTimings(app.client,userId);
  }catch{setError('The study preference could not be saved. Use the current native build and retry.');}finally{setBusy(false);}};
  return <InfoCard><Text accessibilityRole="header" style={{color:colors.textPrimary,fontSize:18,fontWeight:'600'}}>Optional capture timing study</Text><Text style={{color:colors.textSecondary}}>{status.statement}</Text><Text style={{color:colors.textSecondary}}>Includes event types for capture, label reading, confirmation, recovery and sharing, plus the software source build when known. No order references or label values enter this study.</Text>{status.granted?<><Text style={{color:colors.textSecondary}}>Timing collection is on for this account and study. Recording content is excluded.</Text><Button label="Stop future study collection" disabled={busy} onPress={()=>void save('withdraw')}/></>:<><Text style={{color:colors.textSecondary}}>Study device (your selection)</Text>{([['s24_ultra','Samsung S24 Ultra'],['a16_5g','Samsung A16 5G'],['other_android','Another Android phone']] as const).map(([value,label])=><Pressable key={value} accessibilityRole="radio" accessibilityState={{checked:deviceClass===value}} onPress={()=>setDeviceClass(value)} style={{paddingVertical:10}}><Text style={{color:colors.textPrimary}}>{deviceClass===value?'◉':'○'} {label}</Text></Pressable>)}<Pressable accessibilityRole="checkbox" accessibilityLabel="I agree to the study statement above" accessibilityState={{checked,disabled:busy}} disabled={busy} onPress={()=>setChecked(value=>!value)} style={{paddingVertical:16}}><Text style={{color:colors.textPrimary}}>{checked?'☑':'☐'} I agree to the study statement above.</Text></Pressable><Button label="Join this timing study" disabled={!checked||busy} onPress={()=>void save('grant')}/></>}{error&&<View accessibilityLiveRegion="polite"><Text style={{color:colors.textPrimary}}>{error}</Text></View>}</InfoCard>;
}
