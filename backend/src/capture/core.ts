/** PackProof Capture Core v1. Pure deterministic logic: no UI, network, clock or camera APIs. */
export const CAPTURE_SCHEMA = 'packproof.capture/1' as const;
export const CORE_VERSION = '1.0.0';
export type Surface = 'ANDROID' | 'IOS' | 'WEB' | 'WAREHOUSE';
export type CaptureState = 'INTENT_CREATED'|'BOUND'|'READY'|'CAPTURING'|'INTERRUPTED'|'CAPTURE_ENDED'|'ATTESTATION_PENDING'|'SEALED_WITHOUT_ATTESTATION'|'SEALED'|'UPLOADING'|'COMMITTED'|'FINALIZED'|'EXPIRED'|'CANCELLED'|'FAILED'|'FAILED_RETRYABLE'|'FAILED_VALIDATION';
const next: Record<CaptureState, readonly CaptureState[]> = {
  INTENT_CREATED:['BOUND','EXPIRED','CANCELLED'], BOUND:['READY','FAILED'], READY:['CAPTURING','CANCELLED','FAILED'],
  CAPTURING:['CAPTURE_ENDED','INTERRUPTED','FAILED'], INTERRUPTED:['CAPTURING','CAPTURE_ENDED','FAILED'],
  CAPTURE_ENDED:['ATTESTATION_PENDING','SEALED_WITHOUT_ATTESTATION','FAILED'], ATTESTATION_PENDING:['SEALED','FAILED'],
  SEALED_WITHOUT_ATTESTATION:['UPLOADING','COMMITTED','ATTESTATION_PENDING','FAILED'], SEALED:['UPLOADING','COMMITTED','FAILED'],
  UPLOADING:['COMMITTED','FAILED_RETRYABLE'], FAILED_RETRYABLE:['UPLOADING','FAILED'], COMMITTED:['FINALIZED','FAILED_VALIDATION'],
  FINALIZED:[], EXPIRED:[], CANCELLED:[], FAILED:[], FAILED_VALIDATION:[],
};
export class CaptureError extends Error { constructor(public code: string, message: string) { super(message); this.name='CaptureError'; } }
export function check(ok: unknown, code: string, message: string): asserts ok { if (!ok) throw new CaptureError(code,message); }
export function transition(state: CaptureState, to: CaptureState): CaptureState {
  check(next[state]?.includes(to), 'CAPTURE_TRANSITION_INVALID', `Cannot transition ${state} to ${to}`); return to;
}
/** Restricted canonical JSON: rejects undefined, nonfinite numbers and non-plain objects. UTF-16 key order is fixed. */
export function canonical(value: unknown): string {
  if (value===null || typeof value==='boolean' || typeof value==='string') return JSON.stringify(value);
  if (typeof value==='number') { check(Number.isFinite(value),'CAPTURE_SCHEMA_INVALID','Numbers must be finite'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  check(typeof value==='object' && value && Object.getPrototypeOf(value)===Object.prototype, 'CAPTURE_SCHEMA_INVALID','Only plain JSON is accepted');
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
}
export type Hash = (value: string) => Promise<string>;
export interface CapabilitySnapshot {
  surface: Surface; cameraSource:'INTEGRATED'|'EXTERNAL'|'UNKNOWN'; timing:'MONOTONIC'|'ENCODER_PROGRESS'|'UNAVAILABLE';
  barcode:boolean; itemVisibility:boolean; durableJournal:boolean; incrementalMedia:boolean; audio:boolean;
  deviceAuthentication:'ANDROID_BIOMETRIC_STRONG'|'IOS_DEVICE_AUTH'|'UNAVAILABLE';
  appIntegrity:'UNAVAILABLE'|'CLIENT_ASSERTED'; storageReserveBytes:number; coreVersion:string;
}
export interface ExpectedFact { kind:'TRACKING'|'ITEM_BARCODE'|'QUANTITY'; value:string; source:string; version:string; }
export interface CaptureContext { schema:typeof CAPTURE_SCHEMA; captureId:string; intentId:string; proofId:string; transactionId:string; transactionDigest:string; actorId:string; policy:CapturePolicy; expected:ExpectedFact[]; capabilities:CapabilitySnapshot; }
export type ObservationType='LABEL'|'ITEM_VISIBLE'|'PACKAGE_VISIBLE'|'ITEM_ENTERED'|'PACKAGE_CLOSED'|'INTERRUPTION'|'CAPTURE_STARTED'|'CAPTURE_ENDED'|'WARNING_OVERRIDDEN';
export interface Observation {
  id:string; captureId:string; type:ObservationType; startMs:number; endMs:number; source:'LIVE_ANALYSIS'|'ENCODED_ANALYSIS'|'DEVICE'|'OPERATOR';
  model:{id:string;version:string;configuration:string;calibration:'NOT_CALIBRATED'|'CALIBRATED'}|null;
  confidence:number|null; value:string|null; timePrecision:'APPROXIMATE'|'ENCODER_TIMELINE';
}
export interface MediaSegment { sequence:number; offsetBytes:number; byteSize:number; sha256:string; previous:string|null; commitment:string; startMs:number; endMs:number; timing:'MEDIA_RANGE'|'CHUNK_ARRIVAL_APPROXIMATE'|'WHOLE_RECORDING'; }
export interface DerivedArtifact { id:string; sha256:string; parentSha256:string; startMs:number; endMs:number; transformation:string; version:string; privacy:'NONE'|'REDACTED'; }
export interface CapturePolicy { id:'fulfillment'; version:1; requireLabel:boolean; requireItemVisibility:boolean; requireUninterrupted:boolean; audioAllowed:boolean; minConfidence:number; minObservations:number; }
export const POLICY: CapturePolicy = {id:'fulfillment',version:1,requireLabel:false,requireItemVisibility:false,requireUninterrupted:false,audioAllowed:false,minConfidence:0.9,minObservations:2};
export interface Requirement {type:'LABEL'|'ITEM_VISIBLE'|'CONTINUITY';state:'SATISFIED'|'MISSING'|'UNAVAILABLE'|'CONFLICT'|'OPTIONAL';support:string[];prompt:string|null;}
export interface EvidenceEvent {id:string;type:ObservationType;support:string[];startMs:number;endMs:number;description:string;ruleVersion:string;}
export interface CaptureManifest { schema:typeof CAPTURE_SCHEMA; coreVersion:string; context:CaptureContext; source:{sha256:string;byteSize:number;contentType:string;durationMs:number};segments:MediaSegment[];observations:Observation[];events:EvidenceEvent[];requirements:Requirement[];derived:DerivedArtifact[];journalRoot:string;mediaRoot:string; }
const types:ObservationType[]=['LABEL','ITEM_VISIBLE','PACKAGE_VISIBLE','ITEM_ENTERED','PACKAGE_CLOSED','INTERRUPTION','CAPTURE_STARTED','CAPTURE_ENDED','WARNING_OVERRIDDEN'];
const digest = (s:unknown) => typeof s==='string' && /^[a-f0-9]{64}$/.test(s);
function keys(value: unknown, allowed: string[]): asserts value is Record<string,unknown> { check(!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>allowed.includes(k)),'CAPTURE_SCHEMA_INVALID','Unexpected capture fields'); }
export function validateCapabilities(c:CapabilitySnapshot): void {
  keys(c,['surface','cameraSource','timing','barcode','itemVisibility','durableJournal','incrementalMedia','audio','deviceAuthentication','appIntegrity','storageReserveBytes','coreVersion']);
  check(['ANDROID','IOS','WEB','WAREHOUSE'].includes(c.surface)&&['INTEGRATED','EXTERNAL','UNKNOWN'].includes(c.cameraSource)&&['MONOTONIC','ENCODER_PROGRESS','UNAVAILABLE'].includes(c.timing),'CAPTURE_CAPABILITIES_INVALID','Declare the actual capture surface and clock');
  for(const k of ['barcode','itemVisibility','durableJournal','incrementalMedia','audio'] as const) check(typeof c[k]==='boolean','CAPTURE_CAPABILITIES_INVALID','Declare available capabilities');
  check(['ANDROID_BIOMETRIC_STRONG','IOS_DEVICE_AUTH','UNAVAILABLE'].includes(c.deviceAuthentication)&&['UNAVAILABLE','CLIENT_ASSERTED'].includes(c.appIntegrity),'CAPTURE_CAPABILITIES_INVALID','Unsupported authentication assurance');
  check(Number.isSafeInteger(c.storageReserveBytes)&&c.storageReserveBytes>=0&&c.coreVersion===CORE_VERSION,'CAPTURE_VERSION_UNSUPPORTED','Update the capture client to a supported version');
  check(!(c.surface==='WEB' && (c.cameraSource!=='UNKNOWN'||c.deviceAuthentication!=='UNAVAILABLE'||c.appIntegrity!=='UNAVAILABLE')),'CAPTURE_CAPABILITIES_INVALID','Browser camera and device origin are not independently attested');
}
export function validateObservation(o:Observation,context:CaptureContext,durationMs:number):void {
  keys(o,['id','captureId','type','startMs','endMs','source','model','confidence','value','timePrecision']);
  check(typeof o.id==='string'&&o.id.length>0&&o.id.length<=128&&o.captureId===context.captureId&&types.includes(o.type),'CAPTURE_OBSERVATION_INVALID','Observation must belong to this capture');
  check(Number.isSafeInteger(o.startMs)&&Number.isSafeInteger(o.endMs)&&o.startMs>=0&&o.endMs>=o.startMs&&o.endMs<=durationMs,'CAPTURE_TIME_INVALID','Observation must reference recorded source time');
  check(['LIVE_ANALYSIS','ENCODED_ANALYSIS','DEVICE','OPERATOR'].includes(o.source)&&['APPROXIMATE','ENCODER_TIMELINE'].includes(o.timePrecision),'CAPTURE_OBSERVATION_INVALID','Declare the observation origin and time precision');
  check(o.confidence===null||(typeof o.confidence==='number'&&Number.isFinite(o.confidence)&&o.confidence>=0&&o.confidence<=1),'CAPTURE_OBSERVATION_INVALID','Invalid observation confidence');
  check(o.value===null||(typeof o.value==='string'&&o.value.length<=128),'CAPTURE_OBSERVATION_INVALID','Only minimized observation values are retained');
  if (o.source==='LIVE_ANALYSIS'||o.source==='ENCODED_ANALYSIS') {
    keys(o.model,['id','version','configuration','calibration']);
    const m=o.model!;
    check([m.id,m.version,m.configuration].every(x=>typeof x==='string'&&x.length>0&&x.length<=120)&&['NOT_CALIBRATED','CALIBRATED'].includes(m.calibration),'CAPTURE_MODEL_REQUIRED','Machine observations require model provenance');
    check(['LABEL','ITEM_VISIBLE','PACKAGE_VISIBLE','ITEM_ENTERED','PACKAGE_CLOSED'].includes(o.type),'CAPTURE_OBSERVATION_INVALID','Detector cannot author device or operator events');
    if(o.type!=='LABEL') check(context.capabilities.itemVisibility,'CAPTURE_CAPABILITY_UNAVAILABLE','Item detector is unavailable');
    else check(context.capabilities.barcode,'CAPTURE_CAPABILITY_UNAVAILABLE','Barcode detector is unavailable');
  } else { check(o.model===null&&o.confidence===null,'CAPTURE_OBSERVATION_INVALID','Device/operator events cannot impersonate a detector');
    check(o.source==='DEVICE'?['INTERRUPTION','CAPTURE_STARTED','CAPTURE_ENDED'].includes(o.type):o.type==='WARNING_OVERRIDDEN','CAPTURE_OBSERVATION_INVALID','Unsupported event origin'); }
  if(o.type==='LABEL') check(typeof o.value==='string'&&/^[A-Z0-9]{10,64}$/.test(o.value),'CAPTURE_LABEL_INVALID','Persist only normalized identifiers');
  else if(o.type==='INTERRUPTION') check(['BACKGROUND','CAMERA_CHANGED','PERMISSION_REVOKED','ENCODER_ERROR','PROCESS_RESTART','STORAGE_PRESSURE','THERMAL','PAUSE','UNKNOWN'].includes(o.value??''),'CAPTURE_OBSERVATION_INVALID','Use a documented interruption reason');
  else check(o.value===null,'CAPTURE_OBSERVATION_INVALID','Free text and incidental personal data are not accepted');
}
export function labelMatch(expected:ExpectedFact[],observations:Observation[]):'MATCH'|'MISMATCH'|'AMBIGUOUS'|'UNKNOWN' {
  const values=new Set(observations.filter(o=>o.type==='LABEL').map(o=>o.value));
  if(values.size>1)return 'AMBIGUOUS'; if(!values.size)return 'UNKNOWN';
  const known=expected.filter(f=>f.kind==='TRACKING').map(f=>f.value);
  if(!known.length)return 'UNKNOWN'; return known.includes([...values][0]!)?'MATCH':'MISMATCH';
}
export function evaluate(context:CaptureContext,observations:Observation[]):Requirement[] {
  const label=observations.filter(o=>o.type==='LABEL'); const match=labelMatch(context.expected,label);
  const item=observations.filter(o=>o.type==='ITEM_VISIBLE'&&o.model?.calibration==='CALIBRATED'&&(o.confidence??0)>=context.policy.minConfidence);
  const interrupted=observations.filter(o=>o.type==='INTERRUPTION');
  return [
    {type:'LABEL',state:match==='MISMATCH'||match==='AMBIGUOUS'?'CONFLICT':match==='MATCH'?'SATISFIED':!context.policy.requireLabel?'OPTIONAL':!context.capabilities.barcode?'UNAVAILABLE':'MISSING',support:label.map(o=>o.id),prompt:match==='MISMATCH'?'This label appears to be for another order':match==='AMBIGUOUS'?'More than one label was seen. Check the package label':context.policy.requireLabel?'Show the shipping label':null},
    {type:'ITEM_VISIBLE',state:!context.capabilities.itemVisibility?'UNAVAILABLE':new Set(item.map(o=>o.startMs)).size>=context.policy.minObservations?'SATISFIED':context.policy.requireItemVisibility?'MISSING':'OPTIONAL',support:item.map(o=>o.id),prompt:context.policy.requireItemVisibility?'Show the item in the package':null},
    {type:'CONTINUITY',state:interrupted.length?(context.policy.requireUninterrupted?'CONFLICT':'OPTIONAL'):observations.some(o=>o.type==='CAPTURE_ENDED')?'SATISFIED':'MISSING',support:interrupted.map(o=>o.id),prompt:null},
  ];
}
export function guidance(requirements:Requirement[]):string|null { return requirements.find(r=>r.state==='CONFLICT'&&r.prompt)?.prompt??requirements.find(r=>r.state==='MISSING'&&r.prompt)?.prompt??null; }
const descriptions:Record<ObservationType,string>={LABEL:'Shipping identifier read (approximate video moment)',ITEM_VISIBLE:'Possible item visibility observed',PACKAGE_VISIBLE:'Possible package visibility observed',ITEM_ENTERED:'Possible item entry observed',PACKAGE_CLOSED:'Possible package closure observed',INTERRUPTION:'Capture interruption reported by the client',CAPTURE_STARTED:'Recording started',CAPTURE_ENDED:'Recording ended',WARNING_OVERRIDDEN:'Operator continued after a warning'};
export function compileEvents(observations:Observation[]):EvidenceEvent[] { return observations.map(o=>({id:`event:${o.id}`,type:o.type,support:[o.id],startMs:o.startMs,endMs:o.endMs,description:descriptions[o.type],ruleVersion:'capture-compiler/1'})); }
export async function chainSegment(input:Omit<MediaSegment,'commitment'>,hash:Hash):Promise<MediaSegment> { return {...input,commitment:await hash('packproof:segment:1\n'+canonical(input))}; }
export async function journalRoot(observations:Observation[],hash:Hash):Promise<string> { let root=await hash('packproof:journal:1'); for(const o of observations) root=await hash('packproof:event:1\n'+root+'\n'+canonical(o)); return root; }
export async function createManifest(context:CaptureContext,source:CaptureManifest['source'],segments:MediaSegment[],observations:Observation[],hash:Hash,derived:DerivedArtifact[]=[]):Promise<CaptureManifest> {
  check(Array.isArray(segments)&&Array.isArray(observations)&&Array.isArray(derived),'CAPTURE_SCHEMA_INVALID','Capture journals must be arrays');
  validateCapabilities(context.capabilities);
  check(context.schema===CAPTURE_SCHEMA&&context.policy.id==='fulfillment'&&context.policy.version===1&&digest(context.transactionDigest),'CAPTURE_VERSION_UNSUPPORTED','Unsupported capture schema or policy');
  check(!context.capabilities.audio||context.policy.audioAllowed,'CAPTURE_AUDIO_NOT_ALLOWED','Audio is disabled by this capture policy');
  keys(source,['sha256','byteSize','contentType','durationMs']);
  check(digest(source.sha256)&&Number.isSafeInteger(source.byteSize)&&source.byteSize>0&&source.byteSize<=250000000&&Number.isSafeInteger(source.durationMs)&&source.durationMs>0&&source.durationMs<=300000&&['video/mp4','video/webm','video/quicktime'].includes(source.contentType),'CAPTURE_SOURCE_INVALID','Invalid source media');
  check(segments.length>0&&segments.length<=2048&&observations.length<=4096&&derived.length<=32,'CAPTURE_LIMIT','Capture journal exceeds the bounded contract');
  const ids=new Set<string>(); let lastTime=0; let offset=0; let previous:string|null=null;
  for(let i=0;i<segments.length;i++) {
    const s=segments[i];keys(s,['sequence','offsetBytes','byteSize','sha256','previous','commitment','startMs','endMs','timing']);
    check(s.sequence===i&&s.offsetBytes===offset&&s.previous===previous&&digest(s.sha256)&&Number.isSafeInteger(s.byteSize)&&s.byteSize>0&&s.byteSize<=source.byteSize,'CAPTURE_SEGMENT_INVALID','Missing, duplicated or reordered media segment');
    check(Number.isSafeInteger(s.startMs)&&Number.isSafeInteger(s.endMs)&&s.startMs>=lastTime&&s.endMs>=s.startMs&&s.endMs<=source.durationMs&&['MEDIA_RANGE','CHUNK_ARRIVAL_APPROXIMATE','WHOLE_RECORDING'].includes(s.timing),'CAPTURE_TIME_INVALID','Invalid segment timing');
    const {commitment,...body}=s; check((await chainSegment(body,hash)).commitment===commitment,'CAPTURE_SEGMENT_INVALID','Segment commitment mismatch');
    previous=commitment;offset+=s.byteSize;lastTime=s.startMs;
  }
  check(offset===source.byteSize,'CAPTURE_SEGMENT_INVALID','Media byte ranges do not cover the source');lastTime=0;
  for(const o of observations) { validateObservation(o,context,source.durationMs);check(!ids.has(o.id)&&o.startMs>=lastTime,'CAPTURE_JOURNAL_INVALID','Duplicate or reordered observation');ids.add(o.id);lastTime=o.startMs; }
  check(observations[0]?.type==='CAPTURE_STARTED'&&observations[0].startMs===0&&observations.at(-1)?.type==='CAPTURE_ENDED'&&observations.at(-1)?.endMs===source.durationMs,'CAPTURE_JOURNAL_INVALID','Journal must include capture start and end');
  for(const d of derived) { keys(d,['id','sha256','parentSha256','startMs','endMs','transformation','version','privacy']);check(digest(d.sha256)&&d.parentSha256===source.sha256&&Number.isSafeInteger(d.startMs)&&Number.isSafeInteger(d.endMs)&&d.startMs>=0&&d.endMs>=d.startMs&&d.endMs<=source.durationMs&&['EXTRACT_FRAME','TRANSCODE','CROP','REDACT'].includes(d.transformation)&&typeof d.version==='string'&&d.version.length>0&&['NONE','REDACTED'].includes(d.privacy),'CAPTURE_DERIVATION_INVALID','Derived artifacts must retain source provenance'); }
  return {schema:CAPTURE_SCHEMA,coreVersion:CORE_VERSION,context,source,segments,observations,events:compileEvents(observations),requirements:evaluate(context,observations),derived,journalRoot:await journalRoot(observations,hash),mediaRoot:previous!};
}
export async function manifestDigest(manifest:CaptureManifest,hash:Hash):Promise<string> { return hash('packproof:manifest:1\n'+canonical(manifest)); }
