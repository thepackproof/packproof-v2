import type { AnalysisRow,WorkerResult,Finding } from './types.js';

type Observation=Record<string,unknown>;
const channels=['identifier','tracking','weight','appearance','surface','condition','provenance'] as const;
function referenceIds(observation:Observation):string[]{return Array.isArray(observation.sourceRefs)?observation.sourceRefs.map(ref=>typeof ref==='string'?ref:String((ref as Record<string,unknown>)?.sourceId)):[];}
function scalar(observation:Observation,channel:string):string|number|null {
 const value=observation.value as Record<string,unknown>|undefined;if(!value)return null;
 if(channel==='identifier')return typeof value.observedText==='string'&&value.observedText.trim()?value.observedText:null;
 if(channel==='tracking')return typeof value.trackingNumber==='string'&&value.trackingNumber.trim()?value.trackingNumber:null;
 if(channel==='weight')return typeof value.grams==='number'&&Number.isFinite(value.grams)&&value.grams>=0?value.grams:null;
 return null;
}
function pairComparison(job:AnalysisRow,records:Observation[],channel:string){
 const sides=job.input_json.sources.map(source=>{
  const observations=records.filter(o=>referenceIds(o).includes(source.sourceId));
  const values=[...new Set(observations.map(o=>scalar(o,channel)).filter((v):v is string|number=>v!==null))];
  return {sourceId:source.sourceId,legId:source.legId,values,observations:observations.length,attributions:[...new Set(observations.map(o=>String(o.attribution??'MACHINE_READING')))]};
 });
 const missing=sides.some(s=>s.values.length===0),ambiguous=sides.some(s=>s.values.length>1);
 const comparisonState=missing?'MISSING_VALUE':ambiguous?'CONFLICTING_VALUES':sides[0].values[0]===sides[1]?.values[0]?'OBSERVED_VALUES_EQUAL':'OBSERVED_VALUES_DIFFER';
 const readingUncertainties=records.map(o=>({sourceRefs:o.sourceRefs,uncertainty:(o.value as Record<string,unknown>|undefined)?.readingUncertainty??o.readingUncertainty??null}));
 return {comparisonState,sides,conflict:ambiguous,readingUncertainties,normalization:'NONE_EXACT_RECORDED_VALUE',qualified:false,
  meaning:channel==='identifier'?'Literal OCR readings only; recognition errors and copied text prevent a physical identity conclusion.':channel==='tracking'?'Recorded tracking identifiers only; reported or decoded labels do not establish physical parcel identity.':'Reported numerical mass only; calibration, scale identity, packaging, timing and participant versus provider provenance remain separate.'};
}

/** Source-scoped descriptive adapters. No vote counting, numeric fusion, or absence-as-agreement. */
export function evidenceMatrix(job:AnalysisRow,supporting:AnalysisRow[],extraObservations:Observation[]=[]):WorkerResult {
 const allowed=new Set(job.input_json.sources.map(s=>s.sourceId));
 const records:Observation[]=[...supporting.flatMap(run=>{
  const details=run.result_json?.details as Record<string,unknown>|undefined;
  return (Array.isArray(details?.observations)?details!.observations as Observation[]:[]).map(o=>({...o,supportingAnalysisId:run.id}));
 }),...extraObservations].filter(o=>referenceIds(o).length>0&&referenceIds(o).every(id=>allowed.has(id)));
 const matrix=channels.map(channel=>{
  const observations=records.filter(o=>o.channel===channel),pair=['identifier','tracking','weight'].includes(channel)?pairComparison(job,observations,channel):null;
  const outcomes=observations.map(o=>String(o.findingState));
  const hasAgreement=outcomes.includes('CONSISTENT'),hasDifference=outcomes.includes('DIFFERENCE_OBSERVED');
  const conflict=Boolean(pair?.conflict)||hasAgreement&&hasDifference;
  // Literal agreement/difference is recorded in comparisonState, with physical confidence kept inconclusive.
  const findingState:Finding=observations.length===0?'NOT_CHECKED':pair?'INCONCLUSIVE':conflict?'INCONCLUSIVE':hasDifference?'DIFFERENCE_OBSERVED':hasAgreement?'CONSISTENT':'INCONCLUSIVE';
  return {type:'COMPARISON_CHANNEL',channel,findingState,sourceRefs:job.input_json.sources.map(s=>({sourceId:s.sourceId})),supportingObservations:observations,comparison:pair,conflict,
   missingReason:observations.length===0?'No source-bound observations for this channel':pair?.comparisonState==='MISSING_VALUE'?'A paired source has no recorded value':null,
   scope:channel==='identifier'?'Observed text only; copied identifiers can agree':channel==='weight'?'Reported mass and attribution only':channel==='tracking'?'Reported or decoded tracking identifiers only':channel==='surface'?'No qualified physical-instance comparison':'Recorded observations only'};
 });
 const differing=matrix.some(r=>r.findingState==='DIFFERENCE_OBSERVED'),agreeing=matrix.some(r=>r.findingState==='CONSISTENT');
 const conflicts=matrix.some(r=>r.conflict)||(differing&&agreeing);
 return {findingState:conflicts?'INCONCLUSIVE':differing?'DIFFERENCE_OBSERVED':matrix.every(r=>r.findingState==='NOT_CHECKED')?'NOT_CHECKED':'RECORDED',observations:matrix,
  coverage:{channels:matrix.length,availableChannels:matrix.filter(r=>r.findingState!=='NOT_CHECKED').length,unresolvedConflict:conflicts,lifecycleLegs:job.input_json.sources.map(s=>s.legId),physicalCorrespondenceQualified:false},
  limitations:['This matrix compares source-attributed observations and does not assign responsibility.','Missing channels remain not checked. Correlated observations are not independent probabilities.','Distinct package subjects are retained across legs; matching text does not establish the same physical item.','Literal OCR equality or disagreement retains recognition uncertainty; reported weights are not independently calibrated measurements.'],
  diagnostics:{policyVersion:job.input_json.policyVersion,conflictPreserved:conflicts}};
}
