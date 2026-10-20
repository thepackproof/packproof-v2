import {useSignalReceipt} from '../experience/signal/use-receipt';
import {presentationForProof} from '../copy/proof-list';
import {workspaceRecordings} from '../copy/workspace-summary';
import {mayCleanUpCapture} from '../capture/recovery-model';
import {RecordThumbnail} from '../ui/RecordThumbnail';
import {View} from 'react-native';
import {usePackProof} from '../app/PackProofProvider';
import {useTaskHome} from '../experience/use-task-home';
import {useTheme} from '../theme/ThemeProvider';
import {AppScreen} from '../ui/AppScreen';
import {WorkspaceHeader} from '../ui/WorkspaceHeader';
import {Button} from '../ui/Button';
import {ErrorBanner} from '../ui/EmptyState';
import {SignalText,SignalParcel,SignalRow,SignalBadge} from '../ui/Signal';
export function SignalHomeScreen(){
 const app=usePackProof(),home=useTaskHome(),{colors}=useTheme();const next=home.recommendation;
 const retained=workspaceRecordings(app.savedRecordings,app.localCapture).filter(row=>row.captureUserId===app.session?.userId&&row.recovery?.apiBaseUrl.replace(/\/+$/,'')===app.apiBaseUrl.replace(/\/+$/,''));
 const pending=retained.find(row=>!['FINALIZED','SUBMITTED'].includes(row.recovery?.phase||''));
 const recentSaved=home.recent.find(row=>row.presentation.completed);
 const featured=app.proofCollection.find(row=>row.proofId===pending?.captureProofId)||recentSaved;
 const uploading=!!pending?.recovery?.submitRequested;
 const paused=uploading&&(app.offline||!!pending?.recovery?.lastError);
 const confirmed=useSignalReceipt(recentSaved?.proofId||'',recentSaved?.updatedAt||'',!!recentSaved);
 const saved=confirmed||!!recentSaved&&retained.some(row=>row.captureProofId===recentSaved.proofId&&row.recovery&&mayCleanUpCapture(row.recovery));
 const mode=paused?'paused':uploading?'uploading':!pending&&recentSaved?'saved':'default';
 const selected=app.proofCollection.find(row=>row.proofId===next.targetId);
 function openProgress(){if(pending?.recovery)app.go('submission',{signalSubmission:{userId:pending.recovery.userId,apiBaseUrl:pending.recovery.apiBaseUrl,proofId:pending.recovery.proofId,operationId:pending.recovery.operationId,uri:pending.uri}});}

 return <AppScreen bottomInset={false} restorationReady={!home.loading} onRefresh={()=>void home.refresh()} refreshing={home.refreshing} initialOffsetY={app.readWorkspaceOffset('home')} onScrollOffset={offset=>app.setWorkspaceOffset('home',offset)}>
  <WorkspaceHeader section="Home"/>
  {mode!=='default'&&featured?<View style={{gap:24,paddingTop:12}}><SignalText kind="mono" muted>{mode==='paused'?'ONE THING NEEDS YOUR ATTENTION.':mode==='uploading'?"WE’LL KEEP THINGS MOVING.":'A CLEAR RECORD. A CONFIDENT SEND.'}</SignalText><SignalText kind="display">{mode==='paused'?"Let’s finish\nthis Proof.":mode==='uploading'?"Carry on.\nWe’re saving.":'Ready for\nthe next one?'}</SignalText><SignalText muted>{mode==='paused'?'Your recording is safe on this device.':mode==='uploading'?'You can keep using PackProof.':'Your last shipment has a record.'}</SignalText>{mode==='saved'&&<Button label="Pack an item" icon="arrow-forward" onPress={()=>app.selectCreateProof()}/>}<View style={{backgroundColor:colors.surface,padding:20,borderRadius:16,gap:16}}><SignalBadge state={saved&&mode==='saved'?'saved':mode==='uploading'?'uploading':'local'}>{mode==='saved'?(saved?'Saved to PackProof':'Proof finalized'):mode==='paused'?'Upload paused':Object.prototype.hasOwnProperty.call(app.uploadProgressByProof,featured.proofId)&&app.uploadProgressByProof[featured.proofId]!=null?`Uploading · ${Math.round(app.uploadProgressByProof[featured.proofId]!)}%`:'Saving in progress'}</SignalBadge>{mode==='saved'?<SignalParcel sealed height={168}/>:<RecordThumbnail large proofId={featured.proofId} derivativeId={featured.thumbnailDerivativeId}/>}<SignalText kind="heading">{featured.transaction.itemTitle||'Packing record'}</SignalText><SignalText kind="small" muted>{featured.transaction.externalReference||featured.proofId}</SignalText><Button label={mode==='saved'?'View your Proof':'View upload progress'} variant="tertiary" icon="arrow-forward" onPress={()=>mode==='saved'?void home.openProof({...featured,presentation:presentationForProof(featured)}):openProgress()}/></View>{mode==='paused'?<Button label="Resume upload" icon="arrow-forward" disabled={app.busy||app.offline} onPress={()=>pending&&void app.resumeSavedCapture(pending)}/>:mode==='uploading'?<Button label="Pack another item" icon="arrow-forward" onPress={()=>app.selectCreateProof()}/>:null}</View>:<View style={{gap:16,paddingTop:12}}><SignalText kind="mono" muted>A CLEAR RECORD. A CONFIDENT SEND.</SignalText><SignalText kind="display">Pack it.{'\n'}Keep the proof.</SignalText><SignalText muted>Record your packing. Keep a clear record of what you sent and how it left your hands.</SignalText><SignalParcel height={152}/><Button label="Pack an item" icon="arrow-forward" onPress={()=>app.selectCreateProof()} disabled={app.busy}/></View>}
  <View style={{borderTopWidth:1,borderTopColor:colors.border,marginTop:8,paddingTop:24,gap:12}}><SignalText kind="heading">{mode!=='default'?'Your records':next.kind==='create_proof'?'Ready when you are':'Pick up where you left off'}</SignalText>{selected ? <SignalRow proof={selected} detail={next.reason} disabled={app.busy} onPress={()=>void home.runAction(next)}/> : !home.loading&&next.kind!=='create_proof'?<Button label={next.buttonLabel} variant="secondary" onPress={()=>void home.runAction(next)}/>:<SignalText kind="small" muted>{home.loading?'Loading your records…':'Your packing records will appear here.'}</SignalText>}{home.recent.filter(row=>row.proofId!==next.targetId).slice(0,3).map(row=><SignalRow key={row.proofId} proof={row} disabled={app.busy} onPress={()=>void home.openProof(row)}/>)}<Button label="View all Proofs" variant="secondary" onPress={()=>{app.setProofsView('all');app.go('proofs');}}/></View>
  {app.offline&&<SignalText kind="small" muted>You’re offline. Your saved recordings stay on this device. Reconnect to continue uploading.</SignalText>}
  {(!app.workspaceReconciled||app.offline)&&<SignalText kind="caption" muted>{home.freshnessLabel}</SignalText>}
  <ErrorBanner message={home.error}/>{home.error&&<Button label="Refresh records" variant="tertiary" onPress={()=>void home.refresh()}/>}
 </AppScreen>;
}
