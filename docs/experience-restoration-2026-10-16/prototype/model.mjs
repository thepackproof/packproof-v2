// DESIGN FIXTURES ONLY. Not imported by the app and never connected to an API.
// Names match the source contracts; receipt events below are explicit demo input.
export function makeRecord(id = 'demo-sale', template = 'COMMERCE_SALE') {
  return { id, template, title: template === 'COMMERCE_SALE' ? 'Handmade ceramic mug' : 'Collector item',
    sessionId: `${id}:session:1`, phase: 'EMPTY', photos: [], recording: null,
    finalized: false, participant: 'optional', offline: false, declaration: false,
    active: false, interrupted: false, historyIssue: false, error: null, bytes: 0, photoTaskAccepted: false };
}
export function requiredViews(record) {
  // CARD_STANDARD_V1 supplies FRONT/BACK; ordinary COMMERCE_SALE has no photo gate.
  return record.template === 'GRADING_SUBMISSION' ? ['FRONT', 'BACK'] : [];
}
export function fileState(file, offline = false) {
  if (file.committed) return { label: 'Saved to PackProof', detail: offline && !file.local ? 'Connect to view the original' : 'Original available', tone: 'success' };
  if (!file.local) return { label: 'Original needed from capture device', detail: 'This device cannot retry without that original.', tone: 'attention' };
  if (file.transferred) return { label: 'Upload complete · Finishing save', detail: 'Waiting for server confirmation. Original kept.', tone: 'neutral' };
  return { label: 'Saved on this device', detail: offline ? 'Waiting for connection · Not uploaded yet' : 'Not uploaded yet', tone: 'neutral' };
}
export function derive(record) {
  const views = requiredViews(record), accepted = new Set(record.photos.map(p=>p.view));
  const remaining = views.filter(v=>!accepted.has(v));
  const files = [...record.photos, ...(record.recording ? [record.recording] : [])];
  const savedCount = files.filter(f=>f.committed).length;
  let task;
  if (record.active) task = { kind:'recording', title:'Recording packing', action:'Stop recording', hint:'Keep the item and packing process in frame.' };
  else if (record.interrupted) task = { kind:'interrupted', title:'Recording interrupted', action:'Review recovery', hint:'This clip cannot be described as continuous. Surviving media is kept.' };
  else if (record.error) task = { kind:'recovery', title:'Your saved recording needs attention', action:'Check save status', hint:record.error };
  else if (record.finalized) task = { kind:'complete', title:'Evidence saved to PackProof', action:'View evidence', hint:'Find this record again in My Proofs.' };
  else if (record.phase === 'BYTES_RECEIVED' || record.phase === 'FINALIZATION_PENDING') task = { kind:'finishing', title:'Finishing save', action:null, hint:'Upload complete. Your original stays on this device until saving is confirmed.' };
  else if (record.phase === 'UPLOADING') task = { kind:'uploading', title:record.offline ? 'Waiting for connection' : 'Saving your evidence', action:null, hint:record.offline ? 'Your original remains on this device.' : 'Your original is kept while the server checks the upload.' };
  else if (remaining.length) task = { kind:'photo', title:`${remaining[0] === 'FRONT' ? 'Front' : 'Back'} photo`, action:'Open camera', hint:'Keep the full item in frame. Review the photo before using it.' };
  else if (views.length && record.photos.some(p=>!p.committed)) task = { kind:'photos-submit', title:'Item photos captured', action:'Save item photos', hint:'Both required views are on this device. Save this item step to continue.' };
  else if (views.length && !record.photoTaskAccepted) task = { kind:'photos-finishing', title:'Finishing the item step', action:null, hint:'The photos are saved to PackProof. Waiting for the workflow to acknowledge this item step.' };
  else if (!record.recording) task = { kind:'packing', title:'Record the packing', action:'Open camera', hint:'Show the item, packing, seal and label in one continuous recording.' };
  else task = { kind:'review', title:'Review and save', action:'Save evidence to PackProof', hint:'Check your recording and confirm the required declaration.' };
  return { ...task, files, remaining, savedCount, localCount:files.filter(f=>!f.committed && f.local).length,
    participant:record.participant === 'waiting' ? 'Your evidence is saved. Waiting for the receiving participant to add theirs.' : 'Recipient participation is optional for this example.' };
}
export function transition(input, event) {
  if (event.proofId !== input.id || (event.sessionId && event.sessionId !== input.sessionId)) return input;
  const record = structuredClone(input);
  const guarded = ['PHOTO_ACCEPTED','RETAKE_PHOTO','RECORD_START','RECORD_ACCEPTED'];
  if (record.finalized && guarded.includes(event.type)) return input;
  switch(event.type) {
    case 'PHOTO_ACCEPTED': {
      if (!event.durable || !requiredViews(record).includes(event.view)) return input;
      const old = record.photos.find(p=>p.view === event.view);
      if (old?.committed) return input;
      record.photos = record.photos.filter(p=>p.view !== event.view);
      record.photos.push({id:`${record.id}:${event.view}`,view:event.view,label:`${event.view === 'FRONT'?'Front':'Back'} photo`,local:true,committed:false,retained:old?.id || null});
      break;
    }
    case 'PHOTO_COMMIT_ACK':
      record.photos.forEach(p=>{ if(event.ids.includes(p.id)) p.committed=true; }); break;
    case 'PHOTO_TASK_ACK':
      if (requiredViews(record).some(v=>!record.photos.some(p=>p.view===v&&p.committed))) return input;
      record.photoTaskAccepted=true; break;
    case 'RECORD_START':
      if (derive(record).kind !== 'packing') return input;
      record.active=true; record.phase='RECORDING'; break;
    case 'RECORD_STOP':
      if (!record.active) return input;
      record.active=false; record.phase='PREPARING'; break;
    case 'RECORD_ACCEPTED':
      if (!event.durable || record.phase !== 'PREPARING') return input;
      record.recording={id:`${record.id}:video`,label:'Packing recording',local:true,committed:false}; record.phase='LOCAL_ONLY'; break;
    case 'DECLARATION': record.declaration=event.checked === true; break;
    case 'SUBMIT':
      if (!record.recording || !record.declaration || record.offline || record.phase !== 'LOCAL_ONLY') return input;
      record.phase='UPLOADING'; record.bytes=0; break;
    case 'TRANSFER_PROGRESS':
      if(record.phase !== 'UPLOADING' || record.offline) return input;
      record.bytes=Math.max(record.bytes,Math.min(100,event.percent)); break;
    case 'TRANSFER_COMPLETE':
      if(record.phase !== 'UPLOADING') return input;
      record.phase='BYTES_RECEIVED'; record.bytes=100; record.recording.transferred=true; break;
    case 'ARTIFACT_ACK':
      if(record.phase !== 'BYTES_RECEIVED' || record.recording.id !== event.artifactId) return input;
      record.recording.committed=true; record.phase='FINALIZATION_PENDING'; break;
    case 'FINALIZATION_ACK':
      if(record.phase !== 'FINALIZATION_PENDING' || !record.declaration || !record.recording?.committed) return input;
      record.finalized=true; record.phase='FINALIZED'; break;
    case 'OFFLINE': record.offline=event.value; break;
    case 'INTERRUPT':
      if (!record.active) return input;
      record.active=false; record.interrupted=true; record.phase='NEEDS_ATTENTION'; break;
    case 'UNKNOWN_RESPONSE':
      record.error='The response did not arrive. Check the server before retrying this same recording.'; break;
    case 'RECONCILE': record.error=null; break;
    default: return input;
  }
  return record;
}

export function scenario(name) {
  const r = makeRecord(name === 'photos' ? 'demo-grading' : 'demo-sale', name === 'photos' ? 'GRADING_SUBMISSION':'COMMERCE_SALE');
  if(name === 'photos') r.photos=[{id:'demo-grading:FRONT',view:'FRONT',label:'Front photo',local:true,committed:false}];
  if(['review','upload','recovery','saved','tools'].includes(name)) {
    r.recording={id:'demo-sale:video',label:'Packing recording',local:true,committed:false}; r.phase='LOCAL_ONLY';
  }
  if(name === 'upload') {r.phase='UPLOADING';r.declaration=true;r.bytes=42;}
  if(name === 'recovery') {r.phase='UPLOADING';r.declaration=true;r.bytes=42;r.offline=true;}
  if(['saved','tools'].includes(name)) {r.phase='FINALIZED';r.finalized=true;r.recording.committed=true;r.declaration=true;r.participant='waiting';}
  return r;
}
