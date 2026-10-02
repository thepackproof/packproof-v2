import type {AnalysisEnvelope, Feature, FindingState, OperationalState, RndFlags, SourceRef} from '../../../packages/evidence-contracts/contracts.mjs';
export type {AnalysisEnvelope,Feature,SourceRef};
export interface AnalysisJob {analysisId:string;feature:Feature;operationalState:OperationalState;findingState:FindingState;result:AnalysisEnvelope|null;errorCode:string|null;createdAt:string;completedAt:string|null;}
export interface ReviewerAnnotation {annotation:{annotationId:string;analysisId:string;actorId:string;statement:string;createdAt:string;sourceRefs:SourceRef[];interval:{startMs:number;endMs:number}|null;supersedesId:string|null};digest:string;}
export interface RndSnapshot {annotations?:ReviewerAnnotation[];analyses:AnalysisJob[];sources:Array<Pick<SourceRef,'sourceId'|'mimeType'|'byteLength'|'sha256'|'relationship'|'retentionState'> & {evidenceId?:string;legId?:string}>;limitations:string[];}
export interface RndCapabilities {enabled:boolean;flags?:RndFlags;features?:RndFlags['features'];killSwitch?:boolean;releaseAuthorized?:boolean;}
export interface DerivativeGrant {grant:{id:string;expiresAt:string;artifactSha256:string;recipeSha256:string};token?:string|null;expired?:boolean;revoked?:boolean;}
export interface RndTransport {
 grants?(proofId:string,analysisId:string):Promise<{grants:DerivativeGrant[]}>;
 createGrant?(proofId:string,analysisId:string,input:{artifactSha256:string;recipeSha256:string;expiresInSeconds:number},key:string):Promise<DerivativeGrant>;
 revokeGrant?(proofId:string,grantId:string):Promise<unknown>;
 annotations?(proofId:string):Promise<{annotations:ReviewerAnnotation[]}>;
 annotate?(proofId:string,input:{analysisId:string;sourceId:string;text:string;interval?:{startMs:number;endMs:number};supersedesId?:string},key:string):Promise<unknown>;
 capabilities():Promise<RndCapabilities>;
 list(proofId:string):Promise<RndSnapshot>;
 consent(proofId:string,granted:boolean,key:string):Promise<unknown>;
 request(proofId:string,input:{feature:Feature;evidenceIds:string[];scope?:string;parameters?:Record<string,unknown>;relatedAnalysisIds?:string[]},key:string):Promise<unknown>;
 export(proofId:string,key:string):Promise<unknown>;
 exportArchive(proofId:string,analysisId?:string):Promise<void>;
 derivative(proofId:string,input:{evidenceIds:string[];parameters:Record<string,unknown>},key:string):Promise<unknown>;
 artifact(proofId:string,analysisId:string,index:number):Promise<SourcePreview>;
 review(proofId:string,analysisId:string,input:{approved:true;artifactSha256:string;recipeSha256:string},key:string):Promise<unknown>;
}
export interface SourcePreview {url:string;mimeType:string;startMs?:number;endMs?:number;}
