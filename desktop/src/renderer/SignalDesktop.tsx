import { orderSourceEvents, selectedSourceEvent } from './source-chronology';
import {useEffect,useState} from 'react';
import type {CanonicalProof,ProofCollectionItem,UploadView} from '../shared/contracts';
import {hasSignalReceipt,signalDuration} from '../../../mobile/src/experience/signal/receipt';
import {SignalBadge,SignalProgress,SignalReceipt,SignalSteps} from '../../../web/src/signal/Signal';
import {Icon,ErrorNotice} from './components';
import {dateTime,errorMessage,presentation} from './presentation';
import {ActivityHistory} from './ActivityHistory';

const pausedStates=new Set(['FAILED','RETRYING','WAITING_FOR_NETWORK','PAUSED','AUTH_REQUIRED','WAITING_FOR_AUTH']);
const localStates=new Set(['REVIEW','INTERRUPTED','RECORDING','AUTHORIZING']);
export function signalJob(job:UploadView){
  if(job.replacement?.decision==='pending')return {state:'local' as const,label:'Choose a take'};
  if(job.state==='REVIEW')return {state:'local' as const,label:job.localCopyAvailable===true?'Saved on this computer':job.localCopyAvailable===false?'Original recording unavailable':'Recording needs review'};
  if(job.state==='INTERRUPTED')return {state:'attention' as const,label:job.localCopyAvailable===true?'Recording interrupted - original retained':job.localCopyAvailable===false?'Interrupted original unavailable':'Recording interrupted'};
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
const homeAssemblies = new Set<string>();
export function SignalHome({proofs,jobs,userId,onCreate,onOpen,onJob,onAll,loading,onRefresh}:{proofs:ProofCollectionItem[];jobs:UploadView[];userId:string;onCreate:()=>void;onOpen:(id:string)=>void;onJob:(job:UploadView)=>void;onAll:()=>void;loading:boolean;onRefresh:()=>void}){
  const available=jobs.filter(job=>!['COMPLETE','DISCARDED','SUBMITTED'].includes(job.state));
  const pending=available.find(job=>pausedStates.has(job.state))||available.find(job=>localStates.has(job.state))||available[0];
  const featured=proofs.find(proof=>proof.proofId===pending?.proofId)||(!pending?proofs[0]:undefined);
  const saved=useSavedReceipt(featured?.proofId||'',userId,!!featured&&presentation(featured).completed);
  const paused=!!pending&&pausedStates.has(pending.state),local=!!pending&&localStates.has(pending.state);
  const [assemble]=useState(()=>{const key=`${userId}:home`;if(homeAssemblies.has(key))return false;homeAssemblies.add(key);if(homeAssemblies.size>64){const first=homeAssemblies.values().next().value;if(first)homeAssemblies.delete(first);}return true;});
  const heading=paused?'Pick up where you left off.':local?'Your recording is ready.':pending?'Your work keeps moving.':'Your next shipment starts here.';
  const description=paused?(pending.error||'Open this operation to see what it needs and resume the same upload.'):local?(pending?.localCopyAvailable===true?'Review the original on this computer before sending it to PackProof.':'Open this operation to inspect its available recording and recovery information.'):pending?'Uploads continue in their existing queue while you use the workspace.':'One continuous recording. A clear record you can return to.';
  return <div className="signal-home-grid eim-desktop-home"><section className="signal-home-primary">
    <span className="signal-mono">EVIDENCE IN MOTION</span><h1 className="signal-display">{heading}</h1><p>{description}</p>
    <section className={`eim-source-hero${assemble?' is-entrance':''}`} aria-label={featured?'Connected record sources':'Start a shipment record'}>
      <span className="eim-source-kicker">{pending?'CURRENT WORK':featured?'CONNECTED RECORD':'READY WHEN YOU ARE'}</span>
      <h2>{featured?.transaction.itemTitle||pending?.label||'Keep the whole story together.'}</h2>
      {featured||pending?<>
        <p className="eim-source-reference">{featured?.transaction.externalReference||featured?.proofId||pending?.proofId}</p>
        <ol className="eim-source-markers" aria-label="Sources present in this record">
          {featured?.transaction.externalReference&&<li><Icon name="orders"/><span>Order context</span></li>}
          {(pending||featured?.thumbnailDerivativeId)&&<li><Icon name="station"/><span>{pending?'Local operation':'Evidence preview'}</span></li>}
          {featured?.transaction.trackingNumber&&<li><Icon name="link"/><span>Shipment reference</span></li>}
          <li><Icon name="proofs"/><span>Proof record</span></li>
        </ol>
      </>:<p>Start with your item. Its recording and available source context stay connected to the same Proof.</p>}
      {saved&&<SignalBadge state="saved">Saved to PackProof</SignalBadge>}
      {!saved&&pending&&<SignalBadge state={signalJob(pending).state}>{signalJob(pending).label}</SignalBadge>}
    </section>
    <button className="primary eim-next-action" onClick={()=>pending&&(paused||local)?onJob(pending):onCreate()}>
      {paused?'Open recovery':local?'Review recording':pending?'Pack another item':'Pack an item'}<Icon name="arrow"/>
    </button>
    {featured&&!pending&&<button className="text-button" onClick={()=>onOpen(featured.proofId)}>View your latest Proof<Icon name="arrow"/></button>}
    {pending&&!paused&&!local&&<button className="text-button" onClick={()=>onJob(pending)}>View actual upload progress<Icon name="arrow"/></button>}
  </section><section className="signal-home-records"><div className="signal-section-title"><h2>Recent Proofs</h2><span>{proofs.length} records</span></div>
    {proofs.length?<SignalProofRows proofs={proofs.slice(0,4)} jobs={jobs} userId={userId} onOpen={onOpen}/>:<div className="eim-home-empty"><Icon name="proofs" size={32}/><h3>{loading?'Loading your workspace':'Your first record belongs here.'}</h3><p>{loading?'Checking available records and pending work.':'Record an item to create a transaction-bound evidence record.'}</p></div>}
    <button onClick={onAll}>View all Proofs</button><button className="text-button" disabled={loading} onClick={onRefresh}>Refresh records</button>
  </section></div>;
}export function SignalSubmission({jobId,proofId,userId,onHome,onOpen,onReview}:{jobId:string;proofId:string;userId:string;onHome:()=>void;onOpen:()=>void;onReview:(job:UploadView)=>void}){
  const [job,setJob]=useState<UploadView|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{let active=true;const read=()=>void window.packproof.uploads.list().then(rows=>{if(active)setJob(rows.find(row=>row.id===jobId&&row.proofId===proofId)||null);}).catch(reason=>{if(active)setError(errorMessage(reason));});read();const unsubscribe=window.packproof.events.subscribe(event=>{if(event.type==='queue')read();});return()=>{active=false;unsubscribe();};},[jobId,proofId,userId]);
  const saved=useSavedReceipt(proofId,userId,!!job?.evidenceId,job?.evidenceId,true);
  async function resume(){if(!job||busy)return;setBusy(true);setError('');try{await window.packproof.uploads.retry(job.id);}catch(reason){setError(errorMessage(reason));}finally{setBusy(false);}}
  if(saved)return <div className="signal-desktop-flow"><SignalSteps step={3}/><SignalReceipt title={saved.transaction.itemTitle||job?.label||'Packing record'} proofId={saved.proofId} savedAt={saved.finalizedAt!} duration={signalDuration(job?.recordedDurationMs)} onView={onOpen} onHome={onHome}/></div>;
  if(job?.state==='SUBMITTED')return <div className="signal-desktop-flow"><SignalSteps step={3}/><SignalBadge state="local">Recording received</SignalBadge><h1>Your record is received.</h1><p>The server has finalized this Proof. {job.localCopyAvailable?'Your original stays on this computer until preservation is confirmed.':'We are checking its preservation receipt.'}</p><button className="primary" onClick={onOpen}>View your Proof</button><button onClick={onHome}>Back to Home</button></div>;
  return <div className="signal-desktop-flow"><SignalSteps step={3}/>{error&&<ErrorNotice>{error}</ErrorNotice>}{job&&localStates.has(job.state)?<><h1>{job.localCopyAvailable===true?'Your take is still here.':'Review this recording.'}</h1><p>{job.localCopyAvailable===true?'Review the original recording before choosing what to do next.':'Inspect the available recording and recovery information before choosing what to do next.'}</p><button className="primary" onClick={()=>onReview(job)}>Review recording</button></>:<SignalProgress originalAvailable={job?.localCopyAvailable} percent={job?.state==='UPLOADING'?job.progress:null} confirming={!!job&&['VERIFYING','COMMITTING','FINALIZING','COMPLETE'].includes(job.state)} paused={!!job&&pausedStates.has(job.state)}>{job?.error&&<p>{job.error}</p>}{job&&pausedStates.has(job.state)&&<button className="primary" disabled={busy} onClick={()=>void resume()}>{busy?'Resuming…':'Resume upload'}</button>}</SignalProgress>}<button onClick={onHome}>Continue to Home</button></div>;
}
export function SignalRecordSummary({proof,userId,onShare}:{proof:CanonicalProof;userId:string;onShare:()=>void}){
  const saved=useSavedReceipt(proof.proofId,userId,proof.status==='FINALIZED');
  const originals=proof.evidence.filter(item=>item.validationStatus==='COMMITTED'||Boolean(item.committedAt));
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const evidence=originals.find(item=>item.evidenceId===selectedId)||originals.find(item=>item.evidenceType==='FULFILLMENT_CAPTURE')||originals[0];
  const mediaKey=`${userId}:${proof.proofId}:${evidence?.evidenceId||''}`;
  const [media,setMedia]=useState<{key:string;url:string}|null>(null),[error,setError]=useState('');
  useEffect(()=>{setSelectedId(null);},[proof.proofId,userId]);
  useEffect(()=>{let active=true;setMedia(null);setError('');if(evidence)void window.packproof.proofs.evidenceUrl(proof.proofId,evidence.evidenceId)
    .then(url=>{if(active)setMedia({key:mediaKey,url});}).catch(reason=>{if(active)setError(errorMessage(reason));});
    return()=>{active=false;};},[mediaKey,proof.proofId,evidence?.evidenceId,userId]);
  return <section className="signal-record-summary eim-desktop-record">
    <SignalBadge state={saved?'saved':'local'}>{saved?'Saved to PackProof':proof.status==='FINALIZED'?'Proof finalized':'Packing record'}</SignalBadge>
    <div className="signal-record-heading"><div><span className="signal-mono">CONNECTED PROOF RECORD</span><h1>{proof.transaction.itemTitle||'Packing record'}</h1><p>{dateTime(proof.finalizedAt||proof.createdAt)} · {proof.transaction.externalReference||proof.proofId}</p></div><button className="primary" onClick={onShare}><Icon name="link"/>Share Proof</button></div>
    <div className="eim-record-layout"><section className="eim-original-focus" aria-label="Original evidence">
      {error&&<ErrorNotice>{error}</ErrorNotice>}
      {media?.key===mediaKey&&evidence?(evidence.contentType?.startsWith('image')?<img className="signal-original-video" src={media.url} alt="Original Proof evidence" onError={()=>setError('This original could not display. Reopen the Proof to retry.')}/>:evidence.contentType?.startsWith('video')||!evidence.contentType?<video key={mediaKey} className="signal-original-video" src={media.url} controls playsInline preload="metadata" aria-label="Original packing recording" onError={()=>setError('This recording could not play. Reopen the Proof to retry.')}/>:<p>This original does not support inline playback. Use the evidence package action to inspect it.</p>):<div className="signal-original-video signal-media-empty"><Icon name="station"/><p>{error?'Original unavailable':evidence?'Loading original evidence.':'No committed original yet.'}</p></div>}
      <div className="eim-original-caption"><span className="signal-mono">ORIGINAL EVIDENCE</span><p>{evidence?`${evidence.evidenceType.replaceAll('_',' ')} · ${dateTime(evidence.committedAt||evidence.createdAt)}`:'Evidence will appear after commitment.'}</p><small>Shown in its original aspect ratio. Recording content and participant statements are attributed to their source.</small></div>
      {originals.length>1&&<div className="eim-source-selection" aria-label="Choose original evidence">{originals.map((item,index)=><button key={item.evidenceId} aria-pressed={item.evidenceId===evidence?.evidenceId} onClick={()=>setSelectedId(item.evidenceId)}>Original {index+1}<small>{item.contentType?.startsWith('image')?'Image':'Recording'}</small></button>)}</div>}
    </section><aside className="eim-record-context"><h2>Record context</h2><dl><dt>Order reference</dt><dd>{proof.transaction.externalReference||'Not provided'}</dd><dt>Shipment reference</dt><dd>{proof.transaction.shipping?.trackingNumber||'Not provided'}</dd><dt>Carrier</dt><dd>{proof.transaction.shipping?.carrier||'Not provided'}</dd><dt>Proof ID</dt><dd className="signal-mono">{proof.proofId}</dd></dl><p className="signal-note">These are source-linked records. Their association does not independently verify the physical parcel.</p></aside></div>
    <div className="signal-record-meta"><div><span className="signal-mono">MANIFEST</span><p className="signal-mono">{proof.integrity?.manifestSha256||'Available after finalization'}</p></div><div><span className="signal-mono">PACKING DECLARATION</span>{proof.attestations?.length?proof.attestations.map(item=><p key={item.attestationId}>{item.statementText||item.statement}<small>{dateTime(item.createdAt)} · Participant statement</small></p>):<p>No packing declaration recorded.</p>}</div></div>
    <SignalSourceChronology key={`${userId}:${proof.proofId}`} proof={proof} onEvidence={setSelectedId}/>
  </section>;
}
function SignalSourceChronology({proof,onEvidence}:{proof:CanonicalProof;onEvidence:(id:string)=>void}){
  const entries=orderSourceEvents(proof.chronology||[]);
  const [selection,setSelection]=useState<string|null>(()=>entries[0]?.id??null);
  const selected=selectedSourceEvent(entries,selection);
  const unavailable=selection!==null&&selected===null;
  const selectedOriginal=selected?.relatedEntityId&&proof.evidence.find(item=>item.evidenceId===selected.relatedEntityId&&Boolean(item.committedAt));
  return <section className="eim-chronology"><div><h2>Source chronology</h2><p>Select an event to inspect its source and context.</p></div><div className="eim-chronology-layout">
    {entries.length?<ol>{entries.map(entry=><li key={entry.id}><button aria-pressed={entry.id===selection} onClick={()=>setSelection(entry.id)}><span className={`eim-source-dot is-${entry.category.toLowerCase()}`} aria-hidden="true"/><span><strong>{entry.title}</strong><small>{dateTime(entry.occurredAt)} · {entry.source}</small></span></button></li>)}</ol>:<p>No source chronology is available for this record yet.</p>}
    {selected?<aside className="eim-source-inspector" aria-label="Selected event source"><span className="signal-mono">{selected.category} SOURCE</span><h3>{selected.title}</h3>{selected.description&&<p>{selected.description}</p>}<dl><dt>Source</dt><dd>{selected.source}</dd>{selected.provider&&<><dt>Provider</dt><dd>{selected.provider}</dd></>}<dt>Occurred (source reported)</dt><dd>{dateTime(selected.occurredAt)}</dd><dt>Event identity</dt><dd className="signal-mono">{selected.id}</dd></dl>{selectedOriginal&&<button onClick={()=>onEvidence(selectedOriginal.evidenceId)}>Focus supporting original<Icon name="arrow"/></button>}<p className="signal-note">This chronology displays available attributed events. Its connection line does not establish a physical chain of custody.</p></aside>:<aside className="eim-source-inspector" aria-label="Source selection"><h3>{unavailable?'Selected source unavailable':'Choose a source event'}</h3><p role={unavailable?'status':undefined}>{unavailable?'The selected event is no longer available in the refreshed record. Choose another event to inspect its source.':'Select an event from the chronology to inspect its source.'}</p>{unavailable&&<><p className="signal-mono">{selection}</p><button onClick={()=>setSelection(null)}>Clear source selection</button></>}</aside>}
  </div></section>;
}export function SignalActivity({jobs,userId,onJob,onProof}:{jobs:UploadView[];userId:string;onJob:(job:UploadView)=>void;onProof:(id:string)=>void}){
 return <><div className="signal-activity-list">{jobs.map(job=><ActivityRow key={`${userId}:${job.id}`} job={job} userId={userId} onOpen={()=>onJob(job)}/>)}{!jobs.length&&<p>Updates will appear as you record and save Proofs.</p>}</div><ActivityHistory key={userId} onOpen={onProof}/><p className="signal-note">Every event stays with its Proof.</p></>;
}
function ActivityRow({job,userId,onOpen}:{job:UploadView;userId:string;onOpen:()=>void}){
 const saved=useSavedReceipt(job.proofId,userId,job.state==='COMPLETE',job.evidenceId),projected=signalJob(job);
 return <button className="signal-activity-row" onClick={onOpen}><span className="signal-activity-icon"><Icon name={saved?'check':localStates.has(job.state)?'station':'uploads'}/></span><span><strong>{saved?'Proof saved to PackProof':projected.label}</strong><p>{job.label}</p></span><time dateTime={job.updatedAt||job.createdAt}>{dateTime(job.updatedAt||job.createdAt)}</time></button>;
}
