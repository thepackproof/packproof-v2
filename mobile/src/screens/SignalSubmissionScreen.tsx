import {useEffect,useState} from 'react';
import {View} from 'react-native';
import {usePackProof} from '../app/PackProofProvider';
import type {ProofView} from '../v2-api';
import {AppScreen} from '../ui/AppScreen';
import {AppHeader} from '../ui/AppHeader';
import {Button} from '../ui/Button';
import {SignalText,SignalSteps,SignalProgress,SignalReceipt} from '../ui/Signal';
import {hasSignalReceipt,signalDuration} from '../experience/signal/receipt';
export function SignalSubmissionScreen(){
 const app=usePackProof(),identity=app.route.signalSubmission;
 const current=identity&&app.session?.userId===identity.userId&&app.client.apiBaseUrl===identity.apiBaseUrl;
 const capture=current?app.savedRecordings.find(row=>row.uri===identity.uri&&row.captureProofId===identity.proofId&&row.recovery?.operationId===identity.operationId):undefined;
 const [confirmed,setConfirmed]=useState<{key:string;proof:ProofView}|null>(null);
 const [checkingError,setCheckingError]=useState<string|null>(null);
 const key=identity?JSON.stringify(identity):'';
 useEffect(()=>{
  let alive=true,running=false,done=false;setConfirmed(null);setCheckingError(null);
  async function refresh(){
   if(!current||!identity||!capture?.uploadEvidenceId||running||done)return;
   running=true;
   try{const [proof,recovery]=await Promise.all([app.client.getProof(identity.proofId),app.client.getProofRecovery(identity.proofId)]);
    if(alive){app.client.assertCaptureAccount(identity.userId,identity.apiBaseUrl);if(hasSignalReceipt(proof,recovery,{proofId:identity.proofId,evidenceId:capture.uploadEvidenceId!})){setConfirmed({key,proof});done=true;}setCheckingError(null);}
   }catch{if(alive)setCheckingError('The server confirmation is unavailable. Your local recording is retained.');}finally{running=false;}
  }
  void refresh();const interval=setInterval(()=>void refresh(),5000);return()=>{alive=false;clearInterval(interval);};
 },[key,current,app.client,capture?.uploadEvidenceId,capture?.recovery?.phase]);
 if(!identity||!current)return <AppScreen><AppHeader title="Saved recording" onBack={()=>app.go('home')}/><SignalText muted>Sign in to the original account to continue this recording.</SignalText><Button label="Back to Home" onPress={()=>app.go('home')}/></AppScreen>;
 const proof=confirmed?.key===key?confirmed.proof:null;
 const title=app.proofCollection.find(row=>row.proofId===identity.proofId)?.transaction.itemTitle||'Packing record';
 const phase=capture?.recovery?.phase;
 const paused=app.offline||phase==='NEEDS_ATTENTION'||phase==='NEEDS_SIGN_IN'||!!capture?.recovery?.lastError;
 const confirming=['BYTES_RECEIVED','PRESERVATION_PENDING','FINALIZATION_PENDING','FINALIZED','SUBMITTED'].includes(phase||'');
 return <AppScreen><AppHeader title={title} onBack={()=>app.go('home')}/>{proof?<SignalReceipt title={proof.transaction.itemTitle||title} proofId={proof.proofId} savedAt={proof.finalizedAt!} duration={signalDuration(capture?.durationMs)} onHome={()=>app.go('home')} onView={()=>void app.run(()=>app.openProof(proof.proofId))}/>:<><SignalSteps step={3}/><SignalProgress paused={paused} confirming={confirming} percent={Object.prototype.hasOwnProperty.call(app.uploadProgressByProof,identity.proofId)?app.uploadProgressByProof[identity.proofId]:null}/><View style={{gap:16,marginTop:24}}>{phase==='SUBMITTED'&&<SignalText kind="small" muted>Recording received. Keep the original until preservation is confirmed.</SignalText>}{checkingError&&<SignalText kind="small" muted>{checkingError}</SignalText>}{capture?.recovery?.lastError&&<SignalText kind="small" muted>{capture.recovery.lastError.message}</SignalText>}{paused&&capture&&<Button label={phase==='CONFIRMATION_NEEDED'?'Review and confirm':'Resume saving'} disabled={app.busy||app.offline} onPress={()=>void app.resumeSavedCapture(capture)}/>}<SignalText kind="small" muted>Your recording stays on this device until saving is confirmed.</SignalText><Button label="Continue to Home" variant="secondary" onPress={()=>app.go('home')}/></View></>}</AppScreen>;
}
