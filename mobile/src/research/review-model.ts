import { assertAnalysisEnvelope, findingLabel, type AnalysisEnvelope, type Feature, type OperationalState, type FindingState } from '../../../packages/evidence-contracts/contracts.mjs';
export interface ResearchAnalysisRow { analysisId: string; feature: Feature; operationalState: OperationalState; findingState: FindingState; result: AnalysisEnvelope | null; errorCode: string | null; }
export interface ResearchSource { evidenceId: string; mimeType: string; byteLength: number; sha256: string; legId: string; relationship?:string; parentEvidenceId?:string; frameReference?:{mediaTimeMs?:number}; }
export interface ResearchReview { analyses: ResearchAnalysisRow[]; sources: ResearchSource[]; limitations: string[]; }
export function checkedReview(input: ResearchReview, proofId: string): ResearchReview {
  for (const row of input.analyses) {
    if (row.result) {
      assertAnalysisEnvelope(row.result);
      if (row.result.proofId !== proofId || row.result.analysisId !== row.analysisId) throw new Error('Research result belongs to another record');
    }
  }
  return input;
}
export function resultLabel(row: ResearchAnalysisRow): string { return findingLabel(row); }
export function comparisonAvailable(sources: ResearchSource[]): boolean { return sources.length === 2 && sources[0].legId !== sources[1].legId; }
export function sourceEvidenceId(sourceId: string): string | null {
  return sourceId.startsWith('rnd_source_') ? sourceId.slice('rnd_source_'.length) : null;
}

export function observationSourceLinks(envelope: AnalysisEnvelope): Array<{ label: string; source: AnalysisEnvelope['sourceRefs'][number]; offsetMs: number; polygon: unknown }> {
  const observations = envelope.details.observations;
  if (!Array.isArray(observations)) return [];
  const links: ReturnType<typeof observationSourceLinks> = [];
  for (const observation of observations.slice(0, 500)) {
    if (!observation || typeof observation !== 'object' || !Array.isArray(observation.sourceRefs)) continue;
    for (const reference of observation.sourceRefs) {
      if (!reference || typeof reference !== 'object') continue;
      const source = envelope.sourceRefs.find(item => item.sourceId === reference.sourceId);
      if (!source || (typeof reference.sha256 === 'string' && reference.sha256.replace(/^sha256:/, '') !== source.sha256.replace(/^sha256:/, '')) ||
          (typeof reference.objectVersionId === 'string' && reference.objectVersionId !== source.objectVersionId)) continue;
      const offsetMs = typeof reference.timeMs === 'number' && Number.isFinite(reference.timeMs) && reference.timeMs >= 0 ? reference.timeMs : 0;
      links.push({ label: typeof observation.type === 'string' ? observation.type.replace(/_/g, ' ') : 'Observation', source, offsetMs, polygon: reference.polygon ?? null });
    }
  }
  return links;
}

export interface ReviewArtifact {name:string;mimeType:string;sha256:string;byteLength:number;index:number}
export function reviewArtifacts(envelope:AnalysisEnvelope):ReviewArtifact[] {
 const artifacts=envelope.details.artifacts;
 if(!Array.isArray(artifacts))return [];
 return artifacts.slice(0,16).map((raw,index)=>({...raw,index,name:typeof raw?.name==='string'?raw.name:`Artifact ${index+1}`})).filter((raw):raw is ReviewArtifact=>typeof raw.name==='string'&&typeof raw.mimeType==='string'&&typeof raw.sha256==='string'&&/^[a-f0-9]{64}$/.test(raw.sha256)&&Number.isSafeInteger(raw.byteLength)&&raw.byteLength>0&&raw.byteLength<=16*1024*1024);
}
export function derivativeReviewBinding(envelope:AnalysisEnvelope,artifact:ReviewArtifact):{artifactSha256:string;recipeSha256:string}|null {
 if(envelope.feature!=='proofshield'||!Array.isArray(envelope.details.observations))return null;
 for(const observation of envelope.details.observations){const record=observation?.record;if(record&&record.derivativeSha256===artifact.sha256&&typeof record.recipeSha256==='string'&&/^[a-f0-9]{64}$/.test(record.recipeSha256))return {artifactSha256:artifact.sha256,recipeSha256:record.recipeSha256};}
 return null;
}
export function privacyMask(value:string){
 const numbers=value.split(',').map(n=>Number(n.trim()));
 if(numbers.length!==4||numbers.some(n=>!Number.isInteger(n))||numbers[0]<0||numbers[1]<0||numbers[2]<=0||numbers[3]<=0||numbers.some(n=>n>16384))throw new Error('Enter mask pixels as x, y, width, height.');
 return {x:numbers[0],y:numbers[1],width:numbers[2],height:numbers[3]};
}
