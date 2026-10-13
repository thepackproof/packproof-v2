import {useEffect,useRef,useState} from 'react';
import {Text,View} from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import {usePackProof} from '../app/PackProofProvider';
import {useTheme} from '../theme/ThemeProvider';
import {exportEvidencePackage} from '../experience/package-export';
import {Button} from './Button';

export function EvidencePackageButton({proofId}:{proofId:string}) {
  const app=usePackProof(),{colors}=useTheme();
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const active=useRef(false),lock=useRef(false);
  const owner=app.session?.userId,base=app.apiBaseUrl;
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[proofId,owner,base]);
  async function download(){
    if(lock.current||!owner)return;
    if(!FileSystem.cacheDirectory){setError('Download storage is unavailable. Restart the app and try again.');return;}
    lock.current=true;setBusy(true);setError('');
    const file=`${FileSystem.cacheDirectory}proof-package-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`;
    try {await exportEvidencePackage({
      authenticate:app.ensureAuth,
      assertCurrent:()=>{app.client.assertCaptureAccount(owner,base);if(!active.current)throw new Error('Reopen this Proof to download its package.');},
      available:()=>Sharing.isAvailableAsync(),
      download:async()=> (await FileSystem.downloadAsync(app.client.evidencePackageUrl(proofId),file,{headers:app.client.authorizedDownloadHeaders()})).status,
      share:()=>Sharing.shareAsync(file,{mimeType:'application/zip',dialogTitle:'Save evidence package'}),
      remove:()=>FileSystem.deleteAsync(file,{idempotent:true}),
    });}catch(reason){if(active.current)setError(reason instanceof Error?reason.message:'Download failed. Try again.');}
    finally{lock.current=false;if(active.current)setBusy(false);}
  }
  return <View style={{gap:8,paddingHorizontal:16}}><Button label={busy?'Preparing download…':'Download evidence package'} variant="secondary" disabled={app.offline||!owner} loading={busy} onPress={()=>void download()}/>{error?<Text accessibilityRole="alert" style={{color:colors.error}}>{error}</Text>:null}</View>;
}
