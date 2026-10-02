export type Feature = 'proofprint'|'verifiedcapture'|'proofsight'|'prooftwin'|'proofmatch'|'prooflive'|'proofshield'|'proofpilot'|'proofwitness'|'proofcollective';
export type RndOperation = 'collection'|'processing'|'internalDisplay'|'customerDisplay';
export type OperationalState = 'QUEUED'|'RUNNING'|'SUCCEEDED'|'FAILED'|'CANCELLED';
export type FindingState = 'RECORDED'|'CONSISTENT'|'DIFFERENCE_OBSERVED'|'INCONCLUSIVE'|'NOT_CHECKED'|'UNSUPPORTED';
export interface Subject {packageInstanceId:string;shipmentLegId:string;productInstanceId?:string|null;}
export interface SourceRef {sourceId:string;proofId:string;objectKey:string;objectVersionId:string;sha256:string;byteLength:number;mimeType:string;captureSessionId:string|null;relationship:'ORIGINAL_RECORDING'|'CONCURRENT_SIDECAR'|'DECODED_FRAME'|'PARTICIPANT_IMPORT';frameReference?:{sampleId:string|null;offsetMs:number|null;clockDomain:string|null;decoderBuild:string|null;rotation:number|null;colorConversion:string|null}|null;retentionState:'AVAILABLE'|'EXPIRED'|'DELETED';}
export interface AnalysisMethod {executableDigest:string;modelDigest:string|null;policyVersion:string;}
export interface AnalysisEnvelope {schemaVersion:'packproof.analysis.v1';feature:Feature;tenantId:string;proofId:string;rootManifestDigest:string;subject:Subject;analysisId:string;sourceRefs:SourceRef[];inputDigest:string;method:AnalysisMethod;operationalState:OperationalState;findingState:FindingState;scope:string;coverage:Record<string,unknown>;reasonCodes:string[];limitations:string[];supersedesId:string|null;serverReceivedAt:string;analyzedAt:string|null;details:Record<string,unknown>;qualification?:{gate:string;scope:string;recordId:string|null;};}
export interface Observation {schemaVersion:'packproof.observation.v1';observationId:string;proofId:string;subject:Subject;sourceRefs:SourceRef[];type:string;attribution:'MACHINE_OBSERVATION'|'PARTICIPANT_STATEMENT'|'PROVIDER_REPORT';value:unknown;method:AnalysisMethod;coverage:Record<string,unknown>;limitations:string[];interval:{startMs:number;endMs:number}|null;polygon:number[][]|null;}
export interface CapabilityProfile {profileId:string;platform:'android'|'ios'|'web'|'windows'|'macos'|'worker';hardware:string|null;os:string|null;streamProfile:string|null;algorithmVersion:string;supportedScope:string[];qualificationRecordId:string|null;gate:'G0'|'G1'|'G2'|'G3'|'G4'|'G5';disabledReason:string|null;}
export interface RndFlags {enabled:boolean;killSwitch:boolean;features:Record<Feature,Record<RndOperation,boolean>>;releaseAuthorized:false;}
export const SCHEMA_VERSION:'packproof.analysis.v1';
export const FEATURES:readonly Feature[];
export const OPERATIONS:readonly RndOperation[];
export const OPERATIONAL_STATES:readonly OperationalState[];
export const FINDING_STATES:readonly FindingState[];
export const FEATURE_LABELS:Record<Feature,string>;
export function canonicalize(value:unknown):string;
export function parseStrictJson(text:string,maxLength?:number):unknown;
export function readRndFlags(env?:Record<string,string|undefined>):RndFlags;
export function requireRndFlag(flags:RndFlags,feature:Feature,operation:RndOperation):true;
export function assertAnalysisEnvelope(value:unknown):AnalysisEnvelope;
export function findingLabel(value:{operationalState:OperationalState;findingState:FindingState}):string;

export interface EvidenceExtension {schemaVersion:"packproof.extension.v1";extensionId:string;proofId:string;tenantId:string;rootManifestDigest:string;sequence:number;previousDigest:string|null;eventKind:"ANALYSIS_COMPLETED";analysis:AnalysisEnvelope;issuedAt:string;}
export interface SignedRecord {canonicalJson:string;digest:string;signature:{algorithm:"ECDSA_SHA_256"|"RSASSA_PSS_SHA_256";keyId:string;signatureBase64:string;signedAt:string;};}
export function assertSourceRef(value:unknown):SourceRef;
export function assertEvidenceExtension(value:unknown):EvidenceExtension;
export function assertSignedRecord(value:unknown):SignedRecord;
