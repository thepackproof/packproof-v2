import type {RndTransport} from '../../../web/src/rnd/types';
import type { Transport } from "../../../packages/onboarding/model";
import type { CanonicalProof, ProofCollectionItem, ProfileView, FulfillmentQueueItem, ConnectedAccountsListView, TransactionWriteInput, PublicProofView } from '../../../web/src/api/types';
export type { CanonicalProof, ProofCollectionItem, ProfileView, FulfillmentQueueItem, ConnectedAccountsListView };
export interface SessionView { userId: string; profile: ProfileView; email?: string }
export interface Detection { rawValue: string; format: string; detectedAtMs: number; confirmed?: boolean; notThisPackage?: boolean }
export interface UploadView { id: string; proofId: string; label: string; state: string; progress: number; byteSize: number; createdAt: string; error?: string; sha256?: string; evidenceId?: string; interrupted?: boolean }
export interface DesktopSettings { cameraId: string; microphoneId: string; audio: boolean; resolution: '720p'|'1080p'; frameRate: 24|30; retentionHours: 0|24|168; notifications: boolean; scannerSuffix: 'Enter'|'Tab'; theme: 'light'|'dark'|'system' }
export interface SystemView { version: string; platform: string; environment: string; online: boolean; configured: boolean; secureStorage: boolean; pendingOtherAccounts: boolean; settings: DesktopSettings; reporting?:{enabled:boolean;configured:boolean;provider:string}; update: {state: string; version?: string; error?: string} }
export interface CaptureInput { proofId: string; label: string; mimeType: string; camera: string; expectedTracking?: string }
export interface CaptureView { id: string; maxRecordingBytes: number; maxRecordingSeconds: number }
export type SharedProofPreview = Pick<PublicProofView,'proofId'|'status'|'evidence'|'evidenceState'|'statements'|'recordAsOf'|'fulfillmentScope'|'integrity'> & {
 disclosure:NonNullable<PublicProofView['disclosure']>;
 tracker?:{itemTitle:string|null;headline:string;shipment?:{carrier:string|null}|null;milestones:Array<{code:string;label:string;occurredAt:string|null;state?:string}>};
 chronology?:Array<{id:string;occurredAt:string;title:string;category:string;source:string;provider?:string;eventType:string}>;
 recordTracking?:{carrier:string|null;status:string|null;lastUpdatedAt:string|null;source:string;syncState:string;events:Array<{id:string;eventType:string;occurredAt:string;source:string;provider:string}>}|null;
};
export interface SharedProofConsent { previewHash:string; originalsReviewed:true; expiresAt:string }
export interface SharedProofLink { url:string; expiresAt:string|null }
export interface DesktopEvent { type: 'queue'|'session'|'update'|'navigate'|'notification'|'system'; path?: string; title?: string; message?: string }
export interface PackProofDesktop {
 rnd:RndTransport & {source(proofId:string,evidenceId:string):Promise<import('../../../web/src/rnd/types').SourcePreview>};
 onboarding:Transport;
 auth: { state(): Promise<SessionView|null>; signIn(input:{email:string;password:string}):Promise<SessionView>; signUp(input:{email:string;password:string}):Promise<{email:string;userConfirmed:boolean}>; confirmSignUp(input:{email:string;code:string}):Promise<void>; resendCode(email:string):Promise<void>; forgotPassword(email:string):Promise<void>; resetPassword(input:{email:string;code:string;password:string}):Promise<void>; signOut():Promise<void> };
 proofs: { list():Promise<ProofCollectionItem[]>; detail(id:string):Promise<CanonicalProof>; create(input:TransactionWriteInput):Promise<CanonicalProof>; finalize(id:string):Promise<CanonicalProof>; sharePreview(id:string):Promise<SharedProofPreview>; share(id:string,input:SharedProofConsent):Promise<SharedProofLink>; export(id:string):Promise<{saved:boolean}>; evidenceUrl(proofId:string,evidenceId:string,previewHash?:string):Promise<string> };
 orders: { list():Promise<FulfillmentQueueItem[]>; resolve(code:string):Promise<{proofId:string}>; sync(connectionId:string):Promise<void> };
 integrations: { list():Promise<ConnectedAccountsListView>; connect(provider:string):Promise<void> };
 capture: { begin(input:CaptureInput):Promise<CaptureView>; append(id:string,sequence:number,bytes:ArrayBuffer):Promise<void>; finish(id:string,input:{detections:Detection[];attestation:boolean;durationMs:number;startedAt?:string;endedAt?:string}):Promise<void>; interrupt(id:string,reason:string):Promise<void> };
 uploads: { list():Promise<UploadView[]>; retry(id:string):Promise<void>; discard(id:string):Promise<void>; pause():Promise<void>; resume():Promise<void> };
 system: { report(code:'CAMERA_PERMISSION_DENIED'|'CAMERA_DISCONNECTED'|'CAMERA_UNAVAILABLE'|'RECORDING_FAILED'):Promise<void>; state():Promise<SystemView>; settings():Promise<DesktopSettings>; saveSettings(value:Partial<DesktopSettings>):Promise<DesktopSettings>; openExternal(url:string):Promise<void>; exportDiagnostics():Promise<string> };
 updates: { check():Promise<void>; download():Promise<void>; install():Promise<void> };
 events: { subscribe(callback:(event:DesktopEvent)=>void):()=>void };
}
declare global { interface Window { packproof: PackProofDesktop } }
