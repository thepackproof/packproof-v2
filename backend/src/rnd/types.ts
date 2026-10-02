import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import type { ObjectStore } from '../s3/object-store.js';
import type { ManifestSigningRuntime } from '../integrity/signing-runtime.js';
import type { AppAttestPolicy,PlayIntegrityPolicy,AndroidKeyAttestationTrustPolicy } from './platform-assurance.js';

export const FEATURES = ['proofprint','verifiedcapture','proofsight','prooftwin','proofmatch','prooflive','proofshield','proofpilot','proofwitness','proofcollective'] as const;
export type Feature = typeof FEATURES[number];
export type Finding = 'RECORDED'|'CONSISTENT'|'DIFFERENCE_OBSERVED'|'INCONCLUSIVE'|'NOT_CHECKED'|'UNSUPPORTED';
export type Operation = 'collection'|'processing'|'internalDisplay'|'customerDisplay';
export interface RndConfig {
 enabled: boolean; killSwitch: boolean; environment: 'research'|'test'|'disabled';
 features: Record<Feature,Record<Operation,boolean>>;
 worker?: {python:string;script:string;timeoutMs:number;maxInputBytes:number;sandbox?:{program:string;args:string[]};proofsightModel?:{path:string;sha256:string;releaseId:string}};
 witness?: {python:string;script:string;logDb:string;logKey:string;logId:string;trustPolicyFile:string;operators?:{operatorId:string;keyFile:string;stateDb:string}[]};
 platform?: {apple?:Omit<AppAttestPolicy,'now'>;android?:PlayIntegrityPolicy;androidKey?:AndroidKeyAttestationTrustPolicy};
 learning?: {trustedPublicKeysHex:string[]};
 zk?: {node:string;script:string;verificationRegistryFile:string;sourcePrivateKeyFile:string;sourcePublicKeyFile:string;timeoutMs:number;sandbox?:{program:string;args:string[]}};
}
export interface RndDeps { db:Database; clock:Clock; objectStore:ObjectStore; manifestSigning?:ManifestSigningRuntime; rnd?:RndConfig; }
export interface Subject {id:string;proofId:string;tenantId:string;legId:string;packageInstanceId:string;}
export interface Source {
 sourceId:string;proofId:string;tenantId:string;subjectId:string;evidenceId:string;legId:string;
 packageInstanceId:string;captureSessionId:string|null;objectKey:string;objectVersionId:string;
 sha256:string;byteLength:number;mimeType:string;
 relationship?:'ORIGINAL_RECORDING'|'CONCURRENT_SIDECAR'|'DECODED_FRAME'|'PARTICIPANT_IMPORT';
 frameReference?:Record<string,unknown>;
}
export interface AnalysisInput { schemaVersion:'packproof.analysis-request.v1'; feature:Feature; proofId:string;tenantId:string;
 actorId:string;rootManifestDigest:string;subject:Subject;sources:Source[];scope:string;policyVersion:string;
 parameters:Record<string,unknown>;relatedAnalysisIds:string[];executableDigest?:string; }
export interface WorkerResult { findingState:Finding; observations:Record<string,unknown>[];coverage:Record<string,unknown>;
 limitations:string[];diagnostics?:Record<string,unknown>;artifacts?:Record<string,unknown>[];provenance?:Record<string,unknown>;resourceUsage?:Record<string,unknown>; }
export interface AnalysisRow { id:string;proof_id:string;tenant_id:string;actor_id:string;feature:Feature;root_digest:string;
 input_json:AnalysisInput;operational_state:'QUEUED'|'RUNNING'|'SUCCEEDED'|'FAILED'|'CANCELLED';attempts:number;
 max_attempts:number;lease_token:string|null;lease_until:string|Date|null;result_json:Record<string,unknown>|null;
 error_code:string|null;created_at:Date|string;completed_at:Date|string|null; }
