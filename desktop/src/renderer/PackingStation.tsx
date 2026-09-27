import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserIdentifierDecoder } from '../../../web/src/capture/identifier-decoder';
import type { CanonicalProof, DesktopSettings, Detection, FulfillmentQueueItem } from '../shared/contracts';
import { Badge, Empty, ErrorNotice, Icon, Modal } from './components';
import { appearsTracking, duration, errorMessage, trackingMatch } from './presentation';

type Phase = 'ready'|'starting'|'recording'|'saving'|'review';
export function PackingStation({proofId, orders, settings, chooseProof, onBusy, onSaved, onSettings}: {
  proofId:string|null;orders:FulfillmentQueueItem[];settings:DesktopSettings;
  chooseProof:(id:string)=>void;onBusy:(busy:boolean)=>void;onSaved:()=>void;onSettings:(settings:DesktopSettings)=>void;
}) {
  const [proof,setProof]=useState<CanonicalProof|null>(null);
  const [phase,setPhase]=useState<Phase>('ready');
  const [devices,setDevices]=useState<MediaDeviceInfo[]>([]);
  const [cameraReady,setCameraReady]=useState(false);
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

  const stop=useCallback((reason?:string)=>{
    if(reason && !interruption.current) interruption.current=reason;
    if(recorder.current?.state==='recording') {
      elapsedFinal.current=performance.now()-started.current;
      captureEndedAt.current=new Date().toISOString();
      updatePhase('saving');
      recorder.current.stop();
    }
  },[]);
  stopRef.current=stop;

  // Preview owns a single camera stream. Changes are disabled throughout recording and review.
  useEffect(()=>{
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
          const message=`The ${track.kind==='video'?'camera':'microphone'} disconnected. The partial recording has been preserved for review.`;
          if(phaseRef.current==='recording')stopRef.current(message);else setError('A recording device disconnected. Reconnect it or select another device.');
        }));
        await enumerate();setCameraReady(true);
      } catch(reason) {
        if(cancelled)return;
        const name=reason instanceof DOMException?reason.name:'';
        setError(name==='NotAllowedError'?'Camera permission was denied. Enable camera access for PackProof in system privacy settings, then retry.':name==='NotReadableError'?'This camera is in use or unavailable. Close other camera apps and retry.':name==='NotFoundError'?'No camera was found. Connect a webcam to prepare your packing station.':errorMessage(reason));
      }
    };
    void open();
    const changed=()=>void enumerate().catch(()=>{});
    navigator.mediaDevices?.addEventListener('devicechange',changed);
    return()=>{cancelled=true;navigator.mediaDevices?.removeEventListener('devicechange',changed);stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;};
  },[settings.cameraId,settings.microphoneId,settings.audio,settings.resolution,settings.frameRate,previewNonce]);

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
    if(!proof||!stream.current||!cameraReady||phaseRef.current!=='ready')return;
    setError('');setSuccess('');setAttested(false);setConfirmedLabel('');setExcludeOtherLabels(false);setDetections([]);setMismatch('');
    detectionsRef.current=[];lastSeen.current.clear();interruption.current='';sequence.current=0;pendingBytes.current=0;totalBytes.current=0;writeChain.current=Promise.resolve();setElapsed(0);updatePhase('starting');
    try {
      const mimeType=['video/webm;codecs=vp8,opus','video/webm;codecs=vp9,opus','video/webm'].find(type=>MediaRecorder.isTypeSupported(type));
      if(!mimeType)throw new Error('This camera cannot record a supported video format.');
      const camera=stream.current.getVideoTracks()[0]?.label||'Selected camera';
      const native=await window.packproof.capture.begin({proofId:proof.proofId,label:proof.transaction.externalReference||proof.transaction.itemTitle||'Shipment recording',mimeType,camera,expectedTracking:expected||undefined});
      captureId.current=native.id;limit.current={bytes:native.maxRecordingBytes,seconds:native.maxRecordingSeconds};
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
      mediaRecorder.onerror=()=>stopRef.current('The camera encoder stopped unexpectedly. Any staged evidence has been preserved.');
      mediaRecorder.onstop=()=>{
        void writeChain.current.then(async()=>{
          if(interruption.current){await window.packproof.capture.interrupt(native.id,interruption.current);setError(interruption.current);captureId.current=null;updatePhase('ready');onSaved();}
          else{setElapsed(elapsedFinal.current);updatePhase('review');}
        }).catch(reason=>{setError(errorMessage(reason));updatePhase('review');});
      };
      started.current=performance.now();captureStartedAt.current=new Date().toISOString();captureEndedAt.current='';mediaRecorder.start(1000);updatePhase('recording');suffixRef.current?.focus();
    }catch(reason){
      if(captureId.current)await window.packproof.capture.interrupt(captureId.current,errorMessage(reason)).catch(()=>{});
      captureId.current=null;setError(errorMessage(reason));updatePhase('ready');
    }
  }

  async function finish() {
    if(!attested||!captureId.current)return;
    setError('');updatePhase('saving');
    try {
      const reviewedDetections=detectionsRef.current.slice(0,500).map(detection=>({...detection,confirmed:confirmedLabel===detection.rawValue||undefined,notThisPackage:excludeOtherLabels&&confirmedLabel!==detection.rawValue&&appearsTracking(detection.rawValue)||undefined}));
      await window.packproof.capture.finish(captureId.current,{detections:reviewedDetections,attestation:true,durationMs:Math.round(elapsedFinal.current),startedAt:captureStartedAt.current,endedAt:captureEndedAt.current});
      captureId.current=null;updatePhase('ready');setSuccess('Evidence secured locally. Uploading in the background when a connection is available.');onSaved();
    }catch(reason){setError(errorMessage(reason));updatePhase('review');}
  }
  async function preserveInterrupted() {
    if(!captureId.current)return;
    try{await window.packproof.capture.interrupt(captureId.current,'Seller has not confirmed the packing declaration.');captureId.current=null;updatePhase('ready');onSaved();}
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
  const canCapture=!!proof&&['READY_FOR_EVIDENCE','EVIDENCE_COMMITTED'].includes(proof.status)&&!proof.finalizedAt;

  return <>
    {error&&<ErrorNotice>{error}</ErrorNotice>}
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
        <div className="capture-toolbar"><div><strong>{phase==='recording'?'One continuous recording':phase==='saving'?'Securing recording locally…':cameraReady?'Camera ready':'Camera needs attention'}</strong><span>{phase==='recording'?'Finish when the package is sealed and labeled.':'Original footage is staged on this workstation as you record.'}</span></div><button className={phase==='recording'?'danger':'primary'} onClick={()=>phase==='recording'?stop():void begin()} disabled={phase!=='recording'&&(!canCapture||!cameraReady||busy)}><Icon name={phase==='recording'?'check':'station'}/>{phase==='recording'?'Finished packing':phase==='starting'?'Preparing…':'Record packing'}</button></div>
        {recognitionError&&<div className="notice">{recognitionError}</div>}
        {mismatch&&<div className="notice warning" role="alert"><Icon name="warning"/><div><strong>This label does not match this shipment.</strong><p>Detected {mismatch}. Expected {expected}. Check the package before continuing. The shipment identity has not changed.</p></div></div>}
        <div className="camera-settings"><label>Camera<select disabled={busy} value={settings.cameraId} onChange={event=>void window.packproof.system.saveSettings({cameraId:event.target.value}).then(onSettings).catch(reason=>setError(errorMessage(reason)))}><option value="">System default</option>{devices.filter(device=>device.kind==='videoinput').map((device,index)=><option key={device.deviceId||index} value={device.deviceId}>{device.label||`Camera ${index+1}`}</option>)}</select></label><label>Resolution<select disabled={busy} value={settings.resolution} onChange={event=>void window.packproof.system.saveSettings({resolution:event.target.value as DesktopSettings['resolution']}).then(onSettings).catch(reason=>setError(errorMessage(reason)))}><option value="1080p">1080p · Recommended</option><option value="720p">720p</option></select></label><label>Audio<select disabled={busy} value={settings.audio?'on':'off'} onChange={event=>void window.packproof.system.saveSettings({audio:event.target.value==='on'}).then(onSettings).catch(reason=>setError(errorMessage(reason)))}><option value="off">Off</option><option value="on">Microphone on</option></select></label>{settings.audio&&<label>Microphone<select disabled={busy} value={settings.microphoneId} onChange={event=>void window.packproof.system.saveSettings({microphoneId:event.target.value}).then(onSettings).catch(reason=>setError(errorMessage(reason)))}><option value="">System default</option>{devices.filter(device=>device.kind==='audioinput').map((device,index)=><option key={device.deviceId||index} value={device.deviceId}>{device.label||`Microphone ${index+1}`}</option>)}</select></label>}</div>
      </section>
      <aside className="station-context">
        <section className="panel"><h2>{phase==='recording'?'Scan shipping label':'Find your shipment'}</h2><form onSubmit={event=>void resolve(event)}><label className="sr-only" htmlFor="station-reference">Order number or tracking barcode</label><div className="input-action"><input id="station-reference" ref={suffixRef} placeholder="Scan or enter order / tracking" value={reference} onChange={event=>setReference(event.target.value)} onKeyDown={event=>{if(settings.scannerSuffix==='Tab'&&event.key==='Tab'&&reference){event.preventDefault();void resolve(event as unknown as React.FormEvent);}}} disabled={busy&&phase!=='recording'}/><button aria-label="Find shipment or add label" disabled={resolving||!reference.trim()}><Icon name="arrow"/></button></div><p className="help">USB and Bluetooth keyboard scanners supported.</p></form>
          {proof?<div className="selected-order"><span className="eyebrow">SELECTED SHIPMENT</span><h3>{proof.transaction.externalReference||'Manual shipment'}</h3><p>{proof.transaction.itemTitle||'Packing evidence'}</p><dl><dt>Tracking</dt><dd>{expected||'Not assigned'}</dd><dt>Carrier</dt><dd>{proof.transaction.shipping?.carrier||'Not assigned'}</dd></dl>{!canCapture&&<div className="notice warning">This Proof cannot receive packing evidence in its current state.</div>}</div>:<p className="muted">Select a synchronized order or open a Proof to begin.</p>}
        </section>
        <section className="panel"><div className="section-heading"><h2>{phase==='recording'?'Detected labels':'Next in queue'}</h2><Badge>{phase==='recording'?detections.length:orders.length}</Badge></div>{phase==='recording'?(detections.length?<ul className="detection-list">{detections.slice().reverse().map((item,index)=><li key={`${item.detectedAtMs}-${index}`}><Icon name={expected&&trackingMatch(item.rawValue,expected)?'check':'orders'}/><div><strong>{item.rawValue}</strong><span>{item.format} · {duration(item.detectedAtMs)}</span></div></li>)}</ul>:<p className="muted">Labels will appear here as they enter the camera view.</p>):(orders.length?<div className="next-orders">{orders.filter(item=>item.proofStatus!=='FINALIZED').slice(0,7).map(item=><button key={item.proofId} disabled={busy} onClick={()=>chooseProof(item.proofId)}><span><strong>{item.externalReference||item.externalOrderId}</strong><small>{item.itemSummary}</small></span><Icon name="arrow" size={16}/></button>)}</div>:<Empty icon="orders" title="No queued orders">Connect a marketplace or start a manual Proof.</Empty>)}</section>
        <div className="station-note"><Icon name="shield"/><p>Original evidence stays on this computer until PackProof confirms it has been committed.</p></div>
      </aside>
    </div>
    {phase==='review'&&<Modal title="Confirm your packing recording" close={()=>{}}><p>Your {duration(elapsedFinal.current)} recording is staged on this computer. Confirm the statement below to queue the upload.</p>{mismatch&&<div className="notice warning">A different tracking label was seen: {mismatch}. Verify that you recorded the correct shipment.</div>}{detectionsRef.current.length>0&&<><label>Shipping label on this package<select value={confirmedLabel} onChange={event=>setConfirmedLabel(event.target.value)}><option value="">No shipping label confirmed</option>{[...new Set(detectionsRef.current.map(item=>item.rawValue))].map(value=><option key={value} value={value}>{value}</option>)}</select></label><p className="help">Choose only the shipping label belonging to this package. Product barcodes may also appear in this list. A different label does not overwrite the order’s existing tracking number.</p>{detectionsRef.current.some(item=>appearsTracking(item.rawValue)&&item.rawValue!==confirmedLabel)&&<label className="check-field"><input type="checkbox" checked={excludeOtherLabels} onChange={event=>setExcludeOtherLabels(event.target.checked)}/><span>The other detected shipping labels do not belong to this package.</span></label>}</>}<label className="check-field"><input type="checkbox" checked={attested} onChange={event=>setAttested(event.target.checked)}/><span>The item shown and attached in this Proof is the item I am shipping.</span></label><p className="help">This is your declaration. PackProof preserves the recording and its source information; it does not independently verify the contents of the package.</p>{error&&<ErrorNotice>{error}</ErrorNotice>}<div className="modal-actions"><button onClick={()=>void preserveInterrupted()}>Preserve without submitting</button><button className="primary" disabled={!attested} onClick={()=>void finish()}><Icon name="uploads"/>Confirm & upload</button></div></Modal>}
  </>;
}
