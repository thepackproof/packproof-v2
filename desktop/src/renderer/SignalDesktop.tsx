import {useEffect,useState} from 'react';
import type {CanonicalProof,ProofCollectionItem,UploadView} from '../shared/contracts';
import {hasSignalReceipt,signalDuration} from '../../../mobile/src/experience/signal/receipt';
import {SignalBadge,SignalParcel,SignalProgress,SignalReceipt,SignalSteps} from '../../../web/src/signal/Signal';
import {Icon,ErrorNotice} from './components';
import {dateTime,errorMessage,presentation} from './presentation';
import {ActivityHistory} from './ActivityHistory';

const pausedStates=new Set(['FAILED','RETRYING','WAITING_FOR_NETWORK','PAUSED','AUTH_REQUIRED','WAITING_FOR_AUTH']);
const localStates=new Set(['REVIEW','INTERRUPTED','RECORDING','AUTHORIZING']);
export function signalJob(job:UploadView){
  if(job.replacement?.decision==='pending')return {state:'local' as const,label:'Choose a take'};
  if(job.state==='REVIEW')return {state:'local' as const,label:'Saved on this computer'};
  if(job.state==='INTERRUPTED')return {state:'attention' as const,label:'Recording interrupted · retained'};
  if(job.state==='SUBMITTED')return {state:'local' as const,label:job.localCopyAvailable?'Recording received · original retained':'Recording received'};
  if(job.state==='COMPLETE')return {state:'local' as const,label:'Proof finalized'};
  if(pausedStates.has(job.state))return {state:'attention' as const,label:`Upload paused${job.progress?` · ${job.progress}%`:''}`};
  return {state:'uploading' as const,label:job.state==='UPLOADING'?`Uploading · ${job.progress}%`:'Saving in progress'};
}
function useSavedReceipt(proofId:string,userId:string,eligible:boolean,evidenceId?:string,poll=false){
  const key=`${userId}:${proofId}:${evidenceId||''}`;
  const [result,setResult]=useState<{key:string;proof:CanonicalProof}|null>(null);
  useEffect(()=>{
    let active=true,complete=false,checking=false;setResult(null);
    const read=async()=>{if(!eligible||complete||checking)return;checking=true;try{
      const [proof,recovery]=await Promise.all([window.packproof.proofs.current(proofId,userId),window.packproof.proofs.recovery(proofId)]);
      const matching=evidenceId||proof.evidence.find(item=>item.validationStatus==='COMMITTED'&&item.evidenceType==='FULFILLMENT_CAPTURE')?.evidenceId;
      if(active&&matching&&hasSignalReceipt(proof,recovery,{proofId,evidenceId:matching})){complete=true;setResult({key,proof});}
    }catch{/* An unavailable receipt never becomes saved UI. */}finally{checking=false;}};
    void read();const timer=poll?setInterval(()=>void read(),5000):undefined;
    return()=>{active=false;if(timer)clearInterval(timer);};
  },[key,eligible,poll,proofId,userId,evidenceId]);
  return result?.key===key?result.proof:null;
}
export function SignalThumbnail({proof}:{proof:ProofCollectionItem}){
  const [source,setSource]=useState<{key:string;url:string}|null>(null);const key=`${proof.proofId}:${proof.thumbnailDerivativeId}`;
  useEffect(()=>{let active=true;if(proof.thumbnailDerivativeId)void window.packproof.proofs.thumbnailUrl(proof.proofId,proof.thumbnailDerivativeId).then(url=>{if(active)setSource({key,url});}).catch(()=>{});return()=>{active=false;};},[key]);
  return <span className="signal-desktop-thumbnail">{source?.key===key?<img src={source.url} alt="Preview from the packing recording" onError={()=>setSource(null)}/>:<Icon name="station" size={28}/>}</span>;
}
function ProofRow({proof,job,userId,onOpen}:{proof:ProofCollectionItem;job?:UploadView;userId:string;onOpen:()=>void}){
  const status=presentation(proof),saved=useSavedReceipt(proof.proofId,userId,status.completed,job?.state==='COMPLETE'?job.evidenceId:undefined);
  const projected=job&&job.state!=='COMPLETE'?signalJob(job):{state:saved?'saved' as const:'local' as const,label:saved?'Saved to PackProof':status.completed?'Proof finalized':status.displayStatus};
  return <li><button className="signal-proof-row" onClick={onOpen}><SignalThumbnail proof={proof}/><span className="signal-row-copy"><strong>{proof.transaction.itemTitle||proof.transaction.externalReference||'Packing record'}</strong><small>{proof.transaction.externalReference||proof.proofId}</small><SignalBadge state={projected.state}>{projected.label}</SignalBadge></span><Icon name="arrow"/></button></li>;
}
export function SignalProofRows({proofs,jobs,userId,onOpen}:{proofs:ProofCollectionItem[];jobs:UploadView[];userId:string;onOpen:(id:string)=>void}){
  return <ul className="task-proof-list">{proofs.map(proof=><ProofRow key={proof.proofId} proof={proof} job={jobs.find(job=>job.proofId===proof.proofId)} userId={userId} onOpen={()=>onOpen(proof.proofId)}/>)}</ul>;
}
export function SignalHome({proofs,jobs,userId,onCreate,onOpen,onJob,onAll,loading,onRefresh}:{proofs:ProofCollectionItem[];jobs:UploadView[];userId:string;onCreate:()=>void;onOpen:(id:string)=>void;onJob:(job:UploadView)=>void;onAll:()=>void;loading:boolean;onRefresh:()=>void}){
  const pending=jobs.find(job=>!['COMPLETE','DISCARDED','SUBMITTED'].includes(job.state));
  const featured=proofs.find(proof=>proof.proofId===pending?.proofId)||proofs.find(proof=>presentation(proof).completed);
  const saved=useSavedReceipt(featured?.proofId||'',userId,!!featured&&presentation(featured).completed);
  const paused=!!pending&&pausedStates.has(pending.state),uploading=!!pending&&!paused&&!localStates.has(pending.state);
  const mode=paused?'paused':uploading?'uploading':!pending&&featured?'saved':'default';
  return <div className="signal-home-grid"><section className="signal-home-primary"><span className="signal-mono">{mode==='paused'?'ONE THING NEEDS YOUR ATTENTION.':mode==='uploading'?"WE’LL KEEP THINGS MOVING.":'A CLEAR RECORD. A CONFIDENT SEND.'}</span><h1 className="signal-display">{mode==='paused'?<>Let’s finish<br/>this Proof.</>:mode==='uploading'?<>Carry on.<br/>We’re saving.</>:mode==='saved'?<>Ready for<br/>the next one?</>:<>Pack it.<br/>Keep the proof.</>}</h1><p>{mode==='default'?'Record your packing. Keep a clear record of what you sent and how it left your hands.':mode==='paused'?'Your recording is safe on this computer.':mode==='uploading'?'You can keep using PackProof.':'Your last shipment has a record.'}</p>{mode==='default'?<><SignalParcel/><button className="primary" onClick={onCreate}>Pack an item <Icon name="arrow"/></button></>:<>{mode==='saved'&&<button className="primary" onClick={onCreate}>Pack an item <Icon name="arrow"/></button>}{featured&&<article className="signal-featured"><SignalBadge state={saved?'saved':uploading?'uploading':'local'}>{saved?'Saved to PackProof':mode==='saved'?'Proof finalized':pending?signalJob(pending).label:'Packing record'}</SignalBadge>{mode==='saved'?<SignalParcel sealed/>:<SignalThumbnail proof={featured}/>}<h2>{featured.transaction.itemTitle||'Packing record'}</h2><p>{featured.transaction.externalReference||featured.proofId}</p><button className="text-button" onClick={()=>pending?onJob(pending):onOpen(featured.proofId)}>{mode==='saved'?'View your Proof':'View upload progress'} <Icon name="arrow"/></button></article>}{pending&&<button className="primary" onClick={()=>paused?onJob(pending):onCreate()}>{paused?'Resume upload':'Pack another item'} <Icon name="arrow"/></button>}</>}</section><section className="signal-home-records"><div className="signal-section-title"><h2>{pending?'Pick up where you left off':'Ready when you are'}</h2></div>{pending&&localStates.has(pending.state)&&<button className="signal-local-card" onClick={()=>onJob(pending)}><Icon name="station"/><span><strong>{pending.label}</strong><SignalBadge state="local">{signalJob(pending).label}</SignalBadge></span><Icon name="arrow"/></button>}{proofs.length?<SignalProofRows proofs={proofs.slice(0,4)} jobs={jobs} userId={userId} onOpen={onOpen}/>:<p>{loading?'Loading your records…':'Your packing records will appear here.'}</p>}<button onClick={onAll}>View all Proofs</button><button className="text-button" disabled={loading} onClick={onRefresh}>Refresh records</button></section></div>;
}
export function SignalSubmission({jobId,proofId,userId,onHome,onOpen,onReview}:{jobId:string;proofId:string;userId:string;onHome:()=>void;onOpen:()=>void;onReview:(job:UploadView)=>void}){
  const [job,setJob]=useState<UploadView|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{let active=true;const read=()=>void window.packproof.uploads.list().then(rows=>{if(active)setJob(rows.find(row=>row.id===jobId&&row.proofId===proofId)||null);}).catch(reason=>{if(active)setError(errorMessage(reason));});read();const unsubscribe=window.packproof.events.subscribe(event=>{if(event.type==='queue')read();});return()=>{active=false;unsubscribe();};},[jobId,proofId,userId]);
  const saved=useSavedReceipt(proofId,userId,!!job?.evidenceId,job?.evidenceId,true);
  async function resume(){if(!job||busy)return;setBusy(true);setError('');try{await window.packproof.uploads.retry(job.id);}catch(reason){setError(errorMessage(reason));}finally{setBusy(false);}}
  if(saved)return <div className="signal-desktop-flow"><SignalSteps step={3}/><SignalReceipt title={saved.transaction.itemTitle||job?.label||'Packing record'} proofId={saved.proofId} savedAt={saved.finalizedAt!} duration={signalDuration(job?.recordedDurationMs)} onView={onOpen} onHome={onHome}/></div>;
  if(job?.state==='SUBMITTED')return <div className="signal-desktop-flow"><SignalSteps step={3}/><SignalBadge state="local">Recording received</SignalBadge><h1>Your record is received.</h1><p>The server has finalized this Proof. {job.localCopyAvailable?'Your original stays on this computer until preservation is confirmed.':'We are checking its preservation receipt.'}</p><button className="primary" onClick={onOpen}>View your Proof</button><button onClick={onHome}>Back to Home</button></div>;
  return <div className="signal-desktop-flow"><SignalSteps step={3}/>{error&&<ErrorNotice>{error}</ErrorNotice>}{job&&localStates.has(job.state)?<><h1>Your take is still here.</h1><p>Review the original recording before choosing what to do next.</p><button className="primary" onClick={()=>onReview(job)}>Review recording</button></>:<SignalProgress percent={job?.state==='UPLOADING'?job.progress:null} confirming={!!job&&['VERIFYING','COMMITTING','FINALIZING','COMPLETE'].includes(job.state)} paused={!!job&&pausedStates.has(job.state)}>{job?.error&&<p>{job.error}</p>}{job&&pausedStates.has(job.state)&&<button className="primary" disabled={busy} onClick={()=>void resume()}>{busy?'Resuming…':'Resume upload'}</button>}</SignalProgress>}<button onClick={onHome}>Continue to Home</button></div>;
}
export function SignalRecordSummary({proof,userId,onShare}:{proof:CanonicalProof;userId:string;onShare:()=>void}){
  const saved=useSavedReceipt(proof.proofId,userId,proof.status==='FINALIZED');
  const evidence=proof.evidence.find(item=>item.evidenceType==='FULFILLMENT_CAPTURE'&&item.validationStatus==='COMMITTED')||proof.evidence.find(item=>item.committedAt);
  const [media,setMedia]=useState<{id:string;url:string}|null>(null),[error,setError]=useState('');
  useEffect(()=>{let active=true;setMedia(null);if(evidence)void window.packproof.proofs.evidenceUrl(proof.proofId,evidence.evidenceId).then(url=>{if(active)setMedia({id:evidence.evidenceId,url});}).catch(reason=>{if(active)setError(errorMessage(reason));});return()=>{active=false;};},[proof.proofId,evidence?.evidenceId,userId]);
  return <section className="signal-record-summary"><SignalBadge state={saved?'saved':'local'}>{saved?'Saved to PackProof':proof.status==='FINALIZED'?'Proof finalized':'Packing record'}</SignalBadge><div className="signal-record-heading"><div><h1>{proof.transaction.itemTitle||'Packing record'}</h1><p>{dateTime(proof.finalizedAt||proof.createdAt)} · {proof.transaction.externalReference||proof.proofId}</p></div><button className="primary" onClick={onShare}><Icon name="link"/>Share Proof</button></div>{error&&<ErrorNotice>{error}</ErrorNotice>}{media&&evidence&&media.id===evidence.evidenceId?<video className="signal-original-video" src={media.url} controls playsInline aria-label="Original packing recording" onError={()=>setError('This recording could not play. Reopen the Proof to retry.')}/>:<div className="signal-original-video signal-media-empty"><Icon name="station"/><p>{evidence?'Loading original recording…':'No packing recording yet.'}</p></div>}<div className="signal-record-meta"><div><span className="signal-mono">PROOF ID</span><p>{proof.proofId}</p></div><div><span className="signal-mono">PACKING CONFIRMATION</span>{proof.attestations?.length?proof.attestations.map(item=><p key={item.attestationId}>{item.statementText||item.statement}<small>{dateTime(item.createdAt)}</small></p>):<p>No packing declaration recorded.</p>}</div></div></section>;
}
export function SignalActivity({jobs,userId,onJob,onProof}:{jobs:UploadView[];userId:string;onJob:(job:UploadView)=>void;onProof:(id:string)=>void}){
 return <><div className="signal-activity-list">{jobs.map(job=><ActivityRow key={`${userId}:${job.id}`} job={job} userId={userId} onOpen={()=>onJob(job)}/>)}{!jobs.length&&<p>Updates will appear as you record and save Proofs.</p>}</div><ActivityHistory key={userId} onOpen={onProof}/><p className="signal-note">Every event stays with its Proof.</p></>;
}
function ActivityRow({job,userId,onOpen}:{job:UploadView;userId:string;onOpen:()=>void}){
 const saved=useSavedReceipt(job.proofId,userId,job.state==='COMPLETE',job.evidenceId),projected=signalJob(job);
 return <button className="signal-activity-row" onClick={onOpen}><span className="signal-activity-icon"><Icon name={saved?'check':localStates.has(job.state)?'station':'uploads'}/></span><span><strong>{saved?'Proof saved to PackProof':projected.label}</strong><p>{job.label}</p></span><time dateTime={job.updatedAt||job.createdAt}>{dateTime(job.updatedAt||job.createdAt)}</time></button>;
}
