import {SIGNAL_ENABLED,SignalSteps,SignalGuide,SignalBadge} from '../../../web/src/signal/Signal';
import type {CaptureReview,UploadView} from '../shared/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserIdentifierDecoder } from '../../../web/src/capture/identifier-decoder';
import type { CanonicalProof, DesktopSettings, Detection, FulfillmentQueueItem, CaptureAllowanceView } from '../shared/contracts';
import { Badge, Empty, ErrorNotice, Icon, Modal } from './components';
import { appearsTracking, bytes, duration, errorMessage, trackingMatch } from './presentation';
import type {StudyApi,StationStudyTimer} from '../../../web/src/analytics/study-capture';
import {selectDesktopStudy,desktopStudyEvent,bindDesktopStudyJob} from './study';

type Phase = 'ready'|'starting'|'recording'|'saving'|'review';
export function PackingStation({proofId, orders, settings, chooseProof, onBusy, onSaved, onSettings,onCreate,onSelect,studyApi,userId,appVersion,reviewId,onHome,onQueued}: {
  reviewId?:string|null;onHome?:()=>void;onQueued?:(job:UploadView)=>void;
  onCreate?:()=>void;onSelect?:()=>void;
  studyApi?:StudyApi|null;userId?:string;appVersion?:string;
  proofId:string|null;orders:FulfillmentQueueItem[];settings:DesktopSettings;
  chooseProof:(id:string)=>void;onBusy:(busy:boolean)=>void;onSaved:()=>void;onSettings:(settings:DesktopSettings)=>void;
}) {
  const [cameraEnabled,setCameraEnabled]=useState(!SIGNAL_ENABLED),[autoStart,setAutoStart]=useState(false),[review,setReview]=useState<CaptureReview|null>(null),[reviewPlayable,setReviewPlayable]=useState(false),[retake,setRetake]=useState(false),[leave,setLeave]=useState(false);
  const replacementId=useRef<string|undefined>(undefined),leaveAfterStop=useRef(false);
  const [proof,setProof]=useState<CanonicalProof|null>(null);
  const [allowance,setAllowance]=useState<CaptureAllowanceView|null>(null);
  const [allowanceError,setAllowanceError]=useState('');
  const [allowanceNonce,setAllowanceNonce]=useState(0);
  const [phase,setPhase]=useState<Phase>('ready');
  const [devices,setDevices]=useState<MediaDeviceInfo[]>([]);
  const [cameraReady,setCameraReady]=useState(false);
  const study=useRef<Promise<StationStudyTimer|null>|null>(null);
  useEffect(()=>{
    study.current=studyApi&&userId&&proofId?selectDesktopStudy(studyApi,userId,appVersion,'deep_link'):null;
    const task=study.current;return()=>{void task?.then(timer=>timer?.suspend());};
  },[studyApi,userId,proofId,appVersion]);
  useEffect(()=>{if(cameraReady&&proofId)desktopStudyEvent(study.current,'capture_ready',true);},[cameraReady,proofId,studyApi]);
  const [error,setError]=useState('');
  const [recognitionError,setRecognitionError]=useState('');
  const [elapsed,setElapsed]=useState(0);
  const [detections,setDetections]=useState<Detection[]>([]);
  const [attested,setAttested]=useState(false);
  const [confirmedLabel,setConfirmedLabel]=useState('');
  const [excludeOtherLabels,setExcludeOtherLabels]=useState(false);
  const [reference,setReference]=useState('');
  const [resolving,setResolving]=useState(false);
  const [mismatch,setMismatch]=useState('');
  const [success,setSuccess]=useState('');
  const [previewNonce,setPreviewNonce]=useState(0);
  const video=useRef<HTMLVideoElement>(null);
  const stream=useRef<MediaStream|null>(null);
  const recorder=useRef<MediaRecorder|null>(null);
  const phaseRef=useRef<Phase>('ready');
  const captureId=useRef<string|null>(null);
  const started=useRef(0);
  const captureStartedAt=useRef('');
  const captureEndedAt=useRef('');
  const elapsedFinal=useRef(0);
  const sequence=useRef(0);
  const writeChain=useRef<Promise<void>>(Promise.resolve());
  const pendingBytes=useRef(0);
  const totalBytes=useRef(0);
  const interruption=useRef('');
  const detectionsRef=useRef<Detection[]>([]);
  const lastSeen=useRef(new Map<string,number>());
  const limit=useRef({bytes:0,seconds:0});
  const suffixRef=useRef<HTMLInputElement>(null);
  const stopRef=useRef<(reason?:string)=>void>(()=>{});
  const expected=proof?.transaction.shipping?.trackingNumber ?? '';
  const busy=phase!=='ready';
  const updatePhase=(value:Phase)=>{phaseRef.current=value;setPhase(value);};

  useEffect(()=>{onBusy(busy);},[busy,onBusy]);
  useEffect(()=>{
    let alive=true;setProof(null);
    if(proofId) void window.packproof.proofs.detail(proofId).then(value=>{if(alive)setProof(value);}).catch(reason=>{if(alive)setError(errorMessage(reason));});
    return()=>{alive=false;};
  },[proofId]);
  useEffect(()=>{
    let alive=true;setAllowance(null);setAllowanceError('');
    if(proof&&userId&&phase==='ready')void window.packproof.capture.preflight(proof.proofId,userId).then(value=>{
      if(alive){if(value.proofId!==proof.proofId)throw new Error('The allowance belongs to a different shipment. Select this Proof again.');setAllowance(value);}
    }).catch(reason=>{if(alive)setAllowanceError(errorMessage(reason));});
    return()=>{alive=false;};
  },[proof,userId,phase,allowanceNonce]);
  useEffect(()=>window.packproof.events.subscribe(event=>{if(event.type==='system'&&phaseRef.current==='ready')setAllowanceNonce(value=>value+1);}),[]);

  const stop=useCallback((reason?:string)=>{
    if(reason && !interruption.current) interruption.current=reason;
    if(recorder.current?.state==='recording') {
      elapsedFinal.current=performance.now()-started.current;
      captureEndedAt.current=new Date().toISOString();
      updatePhase('saving');
      recorder.current.stop();
      desktopStudyEvent(study.current,reason?'capture_interrupted':'recording_stopped');
    }
  },[]);
  stopRef.current=stop;

  // Preview owns a single camera stream. Changes are disabled throughout recording and review.
  useEffect(()=>{
    if(!cameraEnabled)return;
    let cancelled=false;
    const enumerate=async()=>{const list=await navigator.mediaDevices.enumerateDevices();if(!cancelled)setDevices(list);return list;};
    const open=async()=>{
      setCameraReady(false);setError('');
      try {
        if(!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is unavailable in this build.');
        const list=await enumerate();
        if(settings.cameraId && !list.some(device=>device.deviceId===settings.cameraId && device.kind==='videoinput') && list.some(device=>device.label)) {
          throw new Error('Your selected camera is disconnected. Select an available camera to continue.');
        }
        const media=await navigator.mediaDevices.getUserMedia({video:{deviceId:settings.cameraId?{exact:settings.cameraId}:undefined,width:{ideal:settings.resolution==='1080p'?1920:1280},height:{ideal:settings.resolution==='1080p'?1080:720},frameRate:{ideal:settings.frameRate}},audio:settings.audio?{deviceId:settings.microphoneId?{exact:settings.microphoneId}:undefined}:false});
        if(cancelled){media.getTracks().forEach(track=>track.stop());return;}
        stream.current=media;
        if(video.current){video.current.srcObject=media;await video.current.play();}
        media.getTracks().forEach(track=>track.addEventListener('ended',()=>{
          setCameraReady(false);
          void window.packproof.system.report?.('CAMERA_DISCONNECTED').catch(()=>{});
          const message=`The ${track.kind==='video'?'camera':'microphone'} disconnected. The partial recording has been preserved for review.`;
          if(phaseRef.current==='recording')stopRef.current(message);else setError('A recording device disconnected. Reconnect it or select another device.');
        }));
        await enumerate();setCameraReady(true);
      } catch(reason) {
        if(cancelled)return;
        const name=reason instanceof DOMException?reason.name:'';
        void window.packproof.system.report?.(name==='NotAllowedError'?'CAMERA_PERMISSION_DENIED':'CAMERA_UNAVAILABLE').catch(()=>{});
        setError(name==='NotAllowedError'?'Camera permission was denied. Enable camera access for PackProof in system privacy settings, then retry.':name==='NotReadableError'?'This camera is in use or unavailable. Close other camera apps and retry.':name==='NotFoundError'?'No camera was found. Connect a webcam to prepare your packing station.':errorMessage(reason));
      }
    };
    void open();
    const changed=()=>void enumerate().catch(()=>{});
    navigator.mediaDevices?.addEventListener('devicechange',changed);
    return()=>{cancelled=true;navigator.mediaDevices?.removeEventListener('devicechange',changed);stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;};
  },[settings.cameraId,settings.microphoneId,settings.audio,settings.resolution,settings.frameRate,previewNonce,cameraEnabled]);

  useEffect(()=>{
    const unload=(event:BeforeUnloadEvent)=>{if(phaseRef.current!=='ready'){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',unload);
    return()=>{window.removeEventListener('beforeunload',unload);if(recorder.current?.state==='recording')stopRef.current('Recording interrupted by navigation.');};
  },[]);

  const observe=useCallback((rawValue:string,format:string,scanner=false)=>{
    if(phaseRef.current!=='recording'||rawValue.length>1024)return;
    const now=performance.now();
    const previous=lastSeen.current.get(rawValue);
    if(!scanner&&previous!==undefined&&now-previous<12000)return;
    lastSeen.current.set(rawValue,now);
    const detection={rawValue,format,detectedAtMs:Math.round(now-started.current)};
    if(detectionsRef.current.length<500) detectionsRef.current=[...detectionsRef.current,detection];
    setDetections(detectionsRef.current.slice(-12));
    if(expected&&appearsTracking(rawValue)&&!trackingMatch(rawValue,expected))setMismatch(rawValue);
    else if(expected&&trackingMatch(rawValue,expected))setMismatch('');
    // A repeated deliberate hardware scan can finish; camera recognition never ends recording.
    if(scanner&&previous!==undefined&&now-previous>1500&&expected&&trackingMatch(rawValue,expected))stopRef.current();
  },[expected]);

  useEffect(()=>{
    if(phase!=='recording')return;
    let cancelled=false;
    let decoder:BrowserIdentifierDecoder;
    try{decoder=new BrowserIdentifierDecoder();}catch(reason){setRecognitionError(errorMessage(reason));return;}
    let timer:ReturnType<typeof setTimeout>;
    const scan=async()=>{
      if(cancelled)return;
      try {
        if(video.current){const result=await decoder.detect(video.current);if(!cancelled&&result){result.codes.forEach(code=>observe(code.rawText,code.symbology));setRecognitionError('');}}
      }catch {if(!cancelled)setRecognitionError('Automatic recognition is unavailable. You can still scan with a USB scanner or finish packing manually.');}
      if(!cancelled)timer=setTimeout(()=>void scan(),700);
    };
    void scan();
    return()=>{cancelled=true;clearTimeout(timer);decoder.close();};
  },[phase,observe]);

  useEffect(()=>{
    if(phase!=='recording')return;
    const timer=setInterval(()=>{
      const time=performance.now()-started.current;setElapsed(time);
      if(limit.current.seconds&&time>=limit.current.seconds*1000)stopRef.current('The recording reached the supported duration limit. The captured portion is preserved; review it in Uploads.');
    },250);
    return()=>clearInterval(timer);
  },[phase]);

  async function begin() {
    if(!proof||allowance?.proofId!==proof.proofId||!stream.current||!cameraReady||phaseRef.current!=='ready')return;
    setError('');setSuccess('');setAttested(false);setConfirmedLabel('');setExcludeOtherLabels(false);setDetections([]);setMismatch('');
    detectionsRef.current=[];lastSeen.current.clear();interruption.current='';sequence.current=0;pendingBytes.current=0;totalBytes.current=0;writeChain.current=Promise.resolve();setElapsed(0);updatePhase('starting');
    try {
      const mimeType=['video/webm;codecs=vp8,opus','video/webm;codecs=vp9,opus','video/webm'].find(type=>MediaRecorder.isTypeSupported(type));
      if(!mimeType)throw new Error('This camera cannot record a supported video format.');
      const camera=stream.current.getVideoTracks()[0]?.label||'Selected camera';
      const native=await window.packproof.capture.begin({replaceId:replacementId.current,proofId:proof.proofId,label:proof.transaction.externalReference||proof.transaction.itemTitle||'Shipment recording',mimeType,camera,expectedTracking:expected||undefined});
      captureId.current=native.id;limit.current={bytes:native.maxRecordingBytes,seconds:native.maxRecordingSeconds};
      if(studyApi&&userId)bindDesktopStudyJob(studyApi,userId,native.id,study.current);
      const mediaRecorder=new MediaRecorder(stream.current,{mimeType,videoBitsPerSecond:settings.resolution==='1080p'?5_000_000:3_000_000,audioBitsPerSecond:96_000});
      recorder.current=mediaRecorder;
      mediaRecorder.ondataavailable=event=>{
        if(!event.data.size)return;
        pendingBytes.current+=event.data.size;totalBytes.current+=event.data.size;
        if(pendingBytes.current>32*1024*1024)stopRef.current('Local storage is too slow to keep up. The partial recording has been preserved.');
        if(limit.current.bytes&&totalBytes.current>limit.current.bytes)stopRef.current('The recording reached the supported file size limit. The captured portion is preserved for review.');
        // Only one bounded ArrayBuffer crosses the native boundary at a time.
        writeChain.current=writeChain.current.then(async()=>{
          for(let offset=0;offset<event.data.size;offset+=1024*1024){
            const part=await event.data.slice(offset,offset+1024*1024).arrayBuffer();
            await window.packproof.capture.append(native.id,sequence.current++,part);
          }
        }).catch(reason=>{interruption.current=errorMessage(reason);stopRef.current(interruption.current);}).finally(()=>{pendingBytes.current-=event.data.size;});
      };
      mediaRecorder.onerror=()=>{void window.packproof.system.report?.('RECORDING_FAILED').catch(()=>{});stopRef.current('The camera encoder stopped unexpectedly. Any staged evidence has been preserved.');};
      mediaRecorder.onstop=()=>{
        void writeChain.current.then(async()=>{
          if(SIGNAL_ENABLED){
            if(interruption.current)await window.packproof.capture.interrupt(native.id,interruption.current);
            else await window.packproof.capture.stage(native.id,{attestation:false,durationMs:Math.round(elapsedFinal.current),startedAt:captureStartedAt.current,endedAt:captureEndedAt.current,detections:detectionsRef.current.slice(0,500)});
            setCameraEnabled(false);await loadReview(native.id);onSaved();
            if(leaveAfterStop.current){leaveAfterStop.current=false;leaveToHome();}
          }else if(interruption.current){await window.packproof.capture.interrupt(native.id,interruption.current);setError(interruption.current);captureId.current=null;updatePhase('ready');onSaved();}
          else{desktopStudyEvent(study.current,'review_opened');setElapsed(elapsedFinal.current);updatePhase('review');}
        }).catch(async reason=>{if(SIGNAL_ENABLED){await window.packproof.capture.interrupt(native.id,'The recording needs recovery before submission.').catch(()=>{});setCameraEnabled(false);await loadReview(native.id).catch(()=>{});}setError(errorMessage(reason));updatePhase('review');});
      };
      started.current=performance.now();captureStartedAt.current=new Date().toISOString();captureEndedAt.current='';mediaRecorder.start(1000);desktopStudyEvent(study.current,'capture_started');void study.current?.then(timer=>timer?.phase('recording'));updatePhase('recording');suffixRef.current?.focus();
    }catch(reason){
      if(captureId.current)await window.packproof.capture.interrupt(captureId.current,errorMessage(reason)).catch(()=>{});
      captureId.current=null;setError(errorMessage(reason));updatePhase('ready');
    }
  }

  async function finish() {
    if(!attested||!captureId.current)return;
    desktopStudyEvent(study.current,'submission_authorized');setError('');updatePhase('saving');
    try {
      const reviewedDetections=detectionsRef.current.slice(0,500).map(detection=>({...detection,confirmed:confirmedLabel===detection.rawValue||undefined,notThisPackage:excludeOtherLabels&&confirmedLabel!==detection.rawValue&&appearsTracking(detection.rawValue)||undefined}));
      const submittedId=captureId.current;
      await window.packproof.capture.finish(submittedId,{detections:reviewedDetections,attestation:true,durationMs:Math.round(elapsedFinal.current),startedAt:captureStartedAt.current,endedAt:captureEndedAt.current});
      desktopStudyEvent(study.current,'capture_saved');void study.current?.then(timer=>{timer?.phase('upload');timer?.event('upload_state_changed',{uploadState:'queued'});});captureId.current=null;updatePhase('ready');setSuccess('Evidence secured locally. Uploading in the background when a connection is available.');onSaved();if(SIGNAL_ENABLED){onBusy(false);const job=(await window.packproof.uploads.list()).find(job=>job.id===submittedId);if(job)onQueued?.(job);}
    }catch(reason){setError(errorMessage(reason));updatePhase('review');}
  }
  function leaveToHome(){onBusy(false);onHome?.();}
  async function loadReview(id:string){
    const selected=await window.packproof.capture.preview(id);captureId.current=selected.id;setReview(selected);setReviewPlayable(false);setAttested(false);replacementId.current=undefined;
    elapsedFinal.current=selected.recordedDurationMs||0;setElapsed(elapsedFinal.current);captureStartedAt.current=selected.metadata.startedAt;captureEndedAt.current=selected.metadata.endedAt||'';
    detectionsRef.current=selected.metadata.detections.map(item=>({rawValue:item.value,format:item.format||'unknown',detectedAtMs:item.detectedAtMs,confirmed:item.confirmed,notThisPackage:item.notThisPackage}));setDetections(detectionsRef.current);interruption.current=selected.state==='INTERRUPTED'?selected.error||'The recording was interrupted.':'';updatePhase('review');
  }
  useEffect(()=>{if(SIGNAL_ENABLED&&reviewId)void loadReview(reviewId).catch(reason=>setError(errorMessage(reason)));},[reviewId]);
  useEffect(()=>{if(autoStart&&cameraReady&&phase==='ready'&&allowance?.proofId===proof?.proofId){setAutoStart(false);void begin();}},[autoStart,cameraReady,phase,allowance,proof]);
  useEffect(()=>{const requested=()=>{if(phaseRef.current==='recording')setLeave(true);else if(phaseRef.current==='review')leaveToHome();};window.addEventListener('signal-desktop-leave',requested);return()=>window.removeEventListener('signal-desktop-leave',requested);},[onHome]);
  async function chooseTake(choice:'original'|'replacement'){
    if(!review)return;setError('');try{const chosen=await window.packproof.capture.choose(review.id,choice);await loadReview(chosen.id);onSaved();}catch(reason){setError(errorMessage(reason));}
  }
  function startRetake(){
    if(!review||review.replacement?.decision==='pending')return;replacementId.current=review.state==='REVIEW'?review.id:undefined;setRetake(false);setReview(null);setAttested(false);setError('');updatePhase('ready');setCameraEnabled(true);setAutoStart(true);
  }
  async function preserveInterrupted() {
    if(!captureId.current)return;
    try{desktopStudyEvent(study.current,'consent_cancelled');await window.packproof.capture.interrupt(captureId.current,'Seller has not confirmed the packing declaration.');captureId.current=null;updatePhase('ready');onSaved();}
    catch(reason){setError(errorMessage(reason));}
  }
  async function resolve(event:React.FormEvent) {
    event.preventDefault();if(!reference.trim())return;
    if(phaseRef.current==='recording'){observe(reference,'keyboard-scanner',true);setReference('');return;}
    if(busy)return;
    setResolving(true);setError('');
    try{const match=await window.packproof.orders.resolve(reference.trim());chooseProof(match.proofId);setReference('');}
    catch(reason){setError(errorMessage(reason));}finally{setResolving(false);}
  }
  useEffect(()=>{
    const shortcut=(event:KeyboardEvent)=>{
      if(event.code!=='Space'||event.repeat||event.ctrlKey||event.metaKey||event.altKey)return;
      const target=event.target as HTMLElement;
      if(target.closest('input,textarea,select,button,[contenteditable="true"]'))return;
      event.preventDefault();if(phaseRef.current==='ready')void begin();else if(phaseRef.current==='recording')stopRef.current();
    };
    window.addEventListener('keydown',shortcut);return()=>window.removeEventListener('keydown',shortcut);
  });
  useEffect(()=>{
    let text='';let last=0;
    const scan=(event:KeyboardEvent)=>{
      if(event.ctrlKey||event.metaKey||event.altKey||event.repeat||event.defaultPrevented)return;
      if((event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]'))return;
      const now=performance.now();
      if(event.key===settings.scannerSuffix){
        const code=text;text='';
        if(code.length<6||now-last>150)return;
        event.preventDefault();
        if(phaseRef.current==='recording')observe(code,'keyboard-scanner',true);
        else if(phaseRef.current==='ready'){
          setResolving(true);setError('');
          void window.packproof.orders.resolve(code).then(result=>chooseProof(result.proofId)).catch(reason=>setError(errorMessage(reason))).finally(()=>setResolving(false));
        }
        return;
      }
      if(event.key.length!==1)return;
      if(now-last>90)text='';
      text=(text+event.key).slice(-512);last=now;
    };
    window.addEventListener('keydown',scan);return()=>window.removeEventListener('keydown',scan);
  },[settings.scannerSuffix,observe,chooseProof]);
  const canCapture=!!proof&&['READY_FOR_EVIDENCE','EVIDENCE_COMMITTED'].includes(proof.status)&&!proof.finalizedAt;

  if(SIGNAL_ENABLED)return <div className={`signal-station ${phase==='recording'?'is-recording':''}`}>
    <div className="signal-flow-top"><button className="icon-button" aria-label="Back to Home" disabled={phase==='starting'||phase==='saving'} onClick={()=>phase==='recording'?setLeave(true):leaveToHome()}><Icon name="close"/></button><span>{proof?.transaction.itemTitle||'Packing station'}</span><span className="signal-mono">{phase==='recording'?'CONTINUOUS RECORDING':'NEW PROOF'}</span></div>
    {phase!=='recording'&&<SignalSteps step={phase==='review'?2:1}/>}
    {error&&<ErrorNotice>{error}</ErrorNotice>}
    <div className={`signal-camera-live${phase==='recording'?'':' signal-hidden'}`}><video ref={video} muted playsInline aria-label="Live packing camera"/><span className="signal-recording-label"><span className="record-dot"/> REC · {duration(elapsed)}</span><div className="signal-camera-bottom"><p>Keep the item, packing and seal in view.</p><button className="signal-stop" aria-label="Stop recording" disabled={phase!=='recording'} onClick={()=>stop()}><span/></button></div></div>
    {phase==='ready'&&<div className="signal-station-ready"><section>{proof?<SignalGuide audio={settings.audio} busy={autoStart} disabled={!canCapture||allowance?.proofId!==proof.proofId||autoStart} onStart={()=>{setCameraEnabled(true);setAutoStart(true);setPreviewNonce(value=>value+1);}}/>:<><h1>What are you packing?</h1><p>Start a new Proof or choose an existing shipment.</p><button className="primary" onClick={onCreate}>Pack an item</button><button onClick={onSelect}>Select a Proof</button></>}{allowanceError&&<ErrorNotice>{allowanceError}</ErrorNotice>}{proof&&!allowance&&!allowanceError&&<p role="status">Checking recording allowance…</p>}{proof&&allowance?.reservation==='UNCONFIRMED'&&<p className="signal-note">You can record locally while offline. Reconnect to confirm submission eligibility.</p>}</section><aside><details open={!proof}><summary>Camera and shipment tools</summary><label>Camera<select disabled={busy} value={settings.cameraId} onChange={event=>void window.packproof.system.saveSettings({cameraId:event.target.value}).then(onSettings).catch(reason=>setError(errorMessage(reason)))}><option value="">System default</option>{devices.filter(device=>device.kind==='videoinput').map((device,index)=><option key={device.deviceId||index} value={device.deviceId}>{device.label||`Camera ${index+1}`}</option>)}</select></label><label>Resolution<select value={settings.resolution} onChange={event=>void window.packproof.system.saveSettings({resolution:event.target.value as DesktopSettings['resolution']}).then(onSettings)}><option value="1080p">1080p</option><option value="720p">720p</option></select></label><label>Audio<select value={settings.audio?'on':'off'} onChange={event=>void window.packproof.system.saveSettings({audio:event.target.value==='on'}).then(onSettings)}><option value="off">Off</option><option value="on">Microphone on</option></select></label>{settings.audio&&<label>Microphone<select value={settings.microphoneId} onChange={event=>void window.packproof.system.saveSettings({microphoneId:event.target.value}).then(onSettings)}><option value="">System default</option>{devices.filter(device=>device.kind==='audioinput').map((device,index)=><option key={device.deviceId||index} value={device.deviceId}>{device.label||`Microphone ${index+1}`}</option>)}</select></label>}<form onSubmit={event=>void resolve(event)}><label>Find a shipment<input placeholder="Scan or enter order / tracking" value={reference} onChange={event=>setReference(event.target.value)}/></label><button disabled={resolving||!reference.trim()}>Find shipment</button></form>{orders.slice(0,7).map(order=><button className="signal-order-option" key={order.proofId} onClick={()=>chooseProof(order.proofId)}>{order.itemSummary||order.externalReference||order.proofId}<Icon name="arrow"/></button>)}</details></aside></div>}
    {['starting','saving'].includes(phase)&&<p role="status">{phase==='starting'?'Preparing your camera…':'Saving the original recording on this computer…'}</p>}
    {phase==='review'&&!review&&<div className="signal-desktop-flow"><p>The recording needs recovery. Its local journal is retained.</p><button onClick={leaveToHome}>Return to Home</button></div>}{phase==='review'&&review&&<section className="signal-desktop-flow signal-review"><h1>{review.state==='INTERRUPTED'?'Your take is still here.':'Review your take.'}</h1><p>{review.state==='INTERRUPTED'?'This recording was interrupted. You can review it; a new continuous take is needed before submission.':'Check the recording before saving your Proof.'}</p>{review.byteSize>0?<video key={review.id} className="signal-original-video" src={review.url} controls playsInline onLoadedMetadata={event=>{const video=event.currentTarget;setReviewPlayable(video.videoWidth>0&&(Number.isFinite(video.duration)?video.duration>0:review.state==='REVIEW'));}} onError={()=>{setReviewPlayable(false);setError('This local recording could not play. The original is retained.');}}/>:<p>No playable bytes are available from this take. Keep the original recording or start a new take.</p>}<div className="signal-review-meta"><SignalBadge state="local">Saved on this computer</SignalBadge><span className="signal-mono">{duration(review.recordedDurationMs||0)}</span></div>{review.replacement?.decision==='pending'?<div className="signal-take-choice"><h2>Choose the take to keep.</h2><p>Both recordings remain on this computer until you choose.</p><button className="primary" disabled={review.state!=='REVIEW'||!reviewPlayable} onClick={()=>void chooseTake('replacement')}>Use new take</button><button onClick={()=>void chooseTake('original')}>Keep original take</button></div>:<><label className="check-field signal-declaration"><input type="checkbox" checked={attested} disabled={review.state!=='REVIEW'||!reviewPlayable} onChange={event=>setAttested(event.target.checked)}/><span>The item shown and attached in this Proof is the item I am shipping.</span></label><button className="primary" disabled={!attested||!reviewPlayable||review.state!=='REVIEW'} onClick={()=>void finish()}>Save to PackProof <Icon name="arrow"/></button><button className="text-button" onClick={()=>setRetake(true)}>Record another take</button><button className="text-button" onClick={leaveToHome}>Continue later</button></>}{detectionsRef.current.length>0&&<details><summary>Review detected shipping labels</summary><label>Label on this package<select value={confirmedLabel} onChange={event=>setConfirmedLabel(event.target.value)}><option value="">No label confirmed</option>{[...new Set(detectionsRef.current.map(item=>item.rawValue))].map(value=><option key={value}>{value}</option>)}</select></label><label className="check-field"><input type="checkbox" checked={excludeOtherLabels} onChange={event=>setExcludeOtherLabels(event.target.checked)}/><span>The other detected shipping labels do not belong to this package.</span></label></details>}</section>}
    {mismatch&&<div className="notice warning">The detected label {mismatch} differs from {expected}. Check this shipment before submitting.</div>}
    {phase==='recording'&&recognitionError&&<p className="signal-note">{recognitionError}</p>}
    {leave&&<Modal title="Leave this recording?" close={()=>setLeave(false)}><p>Stop recording to keep this take on this computer. An interrupted take cannot be submitted as a complete packing record.</p><div className="signal-sheet-actions"><button className="primary" onClick={()=>setLeave(false)}>Keep recording</button><button onClick={()=>{setLeave(false);leaveAfterStop.current=true;stop('Recording stopped before completion. The local original is retained.');}}>Stop and save on this computer</button></div></Modal>}
    {retake&&<Modal title="Record another take?" close={()=>setRetake(false)}><p>Your current take stays on this computer while you record again. You’ll choose which complete take to keep.</p><div className="signal-sheet-actions"><button className="primary" onClick={startRetake}>Record new take</button><button onClick={()=>setRetake(false)}>Keep this take</button></div></Modal>}
  </div>;

  return <>
    {error&&<ErrorNotice>{error}</ErrorNotice>}
    {proof&&phase==='ready'&&<div className={`notice ${allowanceError||allowance?.reservation==='UNCONFIRMED'?'warning':''}`} role="status"><Icon name="shield"/><span>{allowanceError?allowanceError:!allowance?'Checking your recording allowance before packing…':allowance.reservation==='UNCONFIRMED'?'Offline local recording only. Your allowance has not been confirmed; submission still depends on server eligibility. Check your current plan before packing.':`${allowance.reservation==='RESERVED'?'One Proof allowance is reserved for this shipment; retakes reuse it.':'Your account can record this Proof without using a paid allowance.'} Record up to ${allowance.maxRecordingSeconds} seconds and ${bytes(allowance.maxRecordingBytes)}. This check does not create a payment.`}</span>{allowanceError&&<button className="text-button" onClick={()=>setAllowanceNonce(value=>value+1)}>Check allowance again</button>}</div>}
    {success&&<div className="notice success" role="status"><Icon name="check"/>{success}</div>}
    <div className="station-layout">
      <section className="station-main">
        <div className="station-steps"><span className={!proof?'current':''}>01 <b>Select shipment</b></span><span className={proof&&phase!=='review'?'current':''}>02 <b>Record packing</b></span><span className={phase==='review'?'current':''}>03 <b>Confirm & queue</b></span></div>
        <div className={`camera-surface ${phase==='recording'?'recording':''}`}>
          <video ref={video} muted playsInline aria-label="Packing camera preview"/>
          {!cameraReady&&<div className="camera-placeholder"><Icon name="station" size={42}/><h3>Prepare your packing camera</h3><p>Connect a webcam and allow camera access.</p><button onClick={()=>setPreviewNonce(value=>value+1)} disabled={busy}>Retry camera</button></div>}
          <div className="camera-top"><span className="camera-label">{phase==='recording'?<><span className="record-dot"/> RECORDING</>:cameraReady?'LIVE PREVIEW':'CAMERA UNAVAILABLE'}</span><span className="camera-timer">{duration(elapsed)}</span></div>
          {phase==='recording'&&<div className="camera-bottom">Keep the item, packing, seal, and label in view.</div>}
        </div>
        <div className="capture-toolbar"><div><strong>{phase==='recording'?'One continuous recording':phase==='saving'?'Securing recording locally…':cameraReady?'Camera ready':'Camera needs attention'}</strong><span>{phase==='recording'?'Finish when the package is sealed and labeled.':'Original footage is staged on this workstation as you record.'}</span></div><button className={phase==='recording'?'danger':'primary'} onClick={()=>phase==='recording'?stop():void begin()} disabled={phase!=='recording'&&(!canCapture||allowance?.proofId!==proof?.proofId||!cameraReady||busy)}><Icon name={phase==='recording'?'check':'station'}/>{phase==='recording'?'Finished packing':phase==='starting'?'Preparing…':'Record packing'}</button></div>
        {recognitionError&&<div className="notice">{recognitionError}</div>}
        {mismatch&&<div className="notice warning" role="alert"><Icon name="warning"/><div><strong>This label does not match this shipment.</strong><p>Detected {mismatch}. Expected {expected}. Check the package before continuing. The shipment identity has not changed.</p></div></div>}
        <div className="camera-settings"><label>Camera<select disabled={busy} value={settings.cameraId} onChange={event=>void window.packproof.system.saveSettings({cameraId:event.target.value}).then(onSettings).catch(reason=>setError(errorMessage(reason)))}><option value="">System default</option>{devices.filter(device=>device.kind==='videoinput').map((device,index)=><option key={device.deviceId||index} value={device.deviceId}>{device.label||`Camera ${index+1}`}</option>)}</select></label><label>Resolution<select disabled={busy} value={settings.resolution} onChange={event=>void window.packproof.system.saveSettings({resolution:event.target.value as DesktopSettings['resolution']}).then(onSettings).catch(reason=>setError(errorMessage(reason)))}><option value="1080p">1080p · Recommended</option><option value="720p">720p</option></select></label><label>Audio<select disabled={busy} value={settings.audio?'on':'off'} onChange={event=>void window.packproof.system.saveSettings({audio:event.target.value==='on'}).then(onSettings).catch(reason=>setError(errorMessage(reason)))}><option value="off">Off</option><option value="on">Microphone on</option></select></label>{settings.audio&&<label>Microphone<select disabled={busy} value={settings.microphoneId} onChange={event=>void window.packproof.system.saveSettings({microphoneId:event.target.value}).then(onSettings).catch(reason=>setError(errorMessage(reason)))}><option value="">System default</option>{devices.filter(device=>device.kind==='audioinput').map((device,index)=><option key={device.deviceId||index} value={device.deviceId}>{device.label||`Microphone ${index+1}`}</option>)}</select></label>}</div>
      </section>
      <aside className="station-context">
        <section className="panel"><h2>{phase==='recording'?'Scan shipping label':'Find your shipment'}</h2><form onSubmit={event=>void resolve(event)}><label className="sr-only" htmlFor="station-reference">Order number or tracking barcode</label><div className="input-action"><input id="station-reference" ref={suffixRef} autoFocus placeholder="Scan or enter order / tracking" value={reference} onChange={event=>setReference(event.target.value)} onKeyDown={event=>{if(settings.scannerSuffix==='Tab'&&event.key==='Tab'&&reference){event.preventDefault();void resolve(event as unknown as React.FormEvent);}}} disabled={busy&&phase!=='recording'}/><button aria-label="Find shipment or add label" disabled={resolving||!reference.trim()}><Icon name="arrow"/></button></div><p className="help">USB and Bluetooth keyboard scanners supported.</p></form>
          {proof?<div className="selected-order"><span className="eyebrow">SELECTED SHIPMENT</span><h3>{proof.transaction.externalReference||'Manual shipment'}</h3><p>{proof.transaction.itemTitle||'Packing evidence'}</p><dl><dt>Tracking</dt><dd>{expected||'Not assigned'}</dd><dt>Carrier</dt><dd>{proof.transaction.shipping?.carrier||'Not assigned'}</dd></dl>{!canCapture&&<div className="notice warning">This Proof cannot receive packing evidence in its current state.</div>}</div>:<p className="muted">Select a synchronized order or open a Proof to begin.</p>}
        </section>
        <section className="panel"><div className="section-heading"><h2>{phase==='recording'?'Detected labels':'Next in queue'}</h2><Badge>{phase==='recording'?detections.length:orders.length}</Badge></div>{phase==='recording'?(detections.length?<ul className="detection-list">{detections.slice().reverse().map((item,index)=><li key={`${item.detectedAtMs}-${index}`}><Icon name={expected&&trackingMatch(item.rawValue,expected)?'check':'orders'}/><div><strong>{item.rawValue}</strong><span>{item.format} · {duration(item.detectedAtMs)}</span></div></li>)}</ul>:<p className="muted">Labels will appear here as they enter the camera view.</p>):(orders.length?<div className="next-orders">{orders.filter(item=>item.proofStatus!=='FINALIZED').slice(0,7).map(item=><button key={item.proofId} disabled={busy} onClick={()=>chooseProof(item.proofId)}><span><strong>{item.externalReference||item.externalOrderId}</strong><small>{item.itemSummary}</small></span><Icon name="arrow" size={16}/></button>)}</div>:<Empty icon="orders" title="Ready for a shipment" action={<div className="button-group">{onCreate&&<button className="primary" disabled={busy} onClick={onCreate}>Record shipment</button>}{onSelect&&<button disabled={busy} onClick={onSelect}>Select existing Proof</button>}</div>}>Record any shipment without connecting a marketplace.</Empty>)}</section>
        <div className="station-note"><Icon name="shield"/><p>Original evidence stays on this computer until PackProof confirms it has been committed.</p></div>
      </aside>
    </div>
    {phase==='review'&&<Modal title="Confirm your packing recording" close={()=>{}}><p>Your {duration(elapsedFinal.current)} recording is staged on this computer. Confirm the statement below to queue the upload.</p>{mismatch&&<div className="notice warning">A different tracking label was seen: {mismatch}. Verify that you recorded the correct shipment.</div>}{detectionsRef.current.length>0&&<><label>Shipping label on this package<select value={confirmedLabel} onChange={event=>setConfirmedLabel(event.target.value)}><option value="">No shipping label confirmed</option>{[...new Set(detectionsRef.current.map(item=>item.rawValue))].map(value=><option key={value} value={value}>{value}</option>)}</select></label><p className="help">Choose only the shipping label belonging to this package. Product barcodes may also appear in this list. A different label does not overwrite the order’s existing tracking number.</p>{detectionsRef.current.some(item=>appearsTracking(item.rawValue)&&item.rawValue!==confirmedLabel)&&<label className="check-field"><input type="checkbox" checked={excludeOtherLabels} onChange={event=>setExcludeOtherLabels(event.target.checked)}/><span>The other detected shipping labels do not belong to this package.</span></label>}</>}<label className="check-field"><input type="checkbox" checked={attested} onChange={event=>setAttested(event.target.checked)}/><span>The item shown and attached in this Proof is the item I am shipping.</span></label><p className="help">This is your declaration. PackProof preserves the recording and its source information; it does not independently verify the contents of the package.</p>{error&&<ErrorNotice>{error}</ErrorNotice>}<div className="modal-actions"><button onClick={()=>void preserveInterrupted()}>Preserve without submitting</button><button className="primary" disabled={!attested} onClick={()=>void finish()}><Icon name="uploads"/>Confirm & upload</button></div></Modal>}
  </>;
}
