import {describe,it,expect} from 'vitest';
import {evidenceMatrix} from '../src/rnd/matrix.js';
import type {AnalysisRow,Source} from '../src/rnd/types.js';
const sources=[{sourceId:'outbound',legId:'OUTBOUND'},{sourceId:'return',legId:'RETURN'}] as Source[];
const job={input_json:{sources,policyVersion:'test'}} as AnalysisRow;
const observed=(sourceId:string,text:string)=>({channel:'identifier',sourceRefs:[{sourceId}],value:{observedText:text,readingUncertainty:'OCR confidence is not calibrated'},findingState:'RECORDED'});
const channel=(result:ReturnType<typeof evidenceMatrix>,name:string)=>result.observations.find(o=>o.channel===name)!;
describe('deterministic source-bound matrix adapters',()=>{
 it('compares exact observed OCR text while preserving reading uncertainty and missingness',()=>{
  const equal=evidenceMatrix(job,[],[observed('outbound','SN 123'),observed('return','SN 123')]);
  expect(channel(equal,'identifier')).toMatchObject({findingState:'INCONCLUSIVE',comparison:{comparisonState:'OBSERVED_VALUES_EQUAL',qualified:false}});
  expect(channel(evidenceMatrix(job,[],[observed('outbound','SN 123'),observed('return','SN 124')]),'identifier')).toMatchObject({comparison:{comparisonState:'OBSERVED_VALUES_DIFFER'}});
  expect(channel(evidenceMatrix(job,[],[observed('outbound','SN 123')]),'identifier')).toMatchObject({comparison:{comparisonState:'MISSING_VALUE'},missingReason:expect.any(String)});
  expect(equal.findingState).toBe('RECORDED');expect(channel(equal,'weight').findingState).toBe('NOT_CHECKED');
 });
 it('retains contradictory alternatives, attributes reported weight and rejects unrelated observation sources',()=>{
  const result=evidenceMatrix(job,[],[observed('outbound','A'),observed('outbound','B'),observed('return','A'),observed('foreign','X'),
   {channel:'weight',sourceRefs:[{sourceId:'outbound'}],attribution:'PARTICIPANT_STATEMENT',value:{grams:1000}},
   {channel:'weight',sourceRefs:[{sourceId:'return'}],attribution:'PROVIDER_REPORT',value:{grams:1250}}]);
  expect(channel(result,'identifier')).toMatchObject({conflict:true,comparison:{comparisonState:'CONFLICTING_VALUES'}});
  expect(channel(result,'weight')).toMatchObject({comparison:{comparisonState:'OBSERVED_VALUES_DIFFER',sides:[{attributions:['PARTICIPANT_STATEMENT']},{attributions:['PROVIDER_REPORT']}]}});
  expect(JSON.stringify(result)).not.toContain('foreign');expect(result.findingState).toBe('INCONCLUSIVE');
 });
 it('retains appearance diagnostics and cross-channel conflicts without a fused score',()=>{
  const result=evidenceMatrix(job,[],[{channel:'appearance',sourceRefs:[{sourceId:'outbound'},{sourceId:'return'}],findingState:'INCONCLUSIVE',value:{histogramIntersection:0.99,qualified:false}},
   {channel:'surface',sourceRefs:[{sourceId:'outbound'},{sourceId:'return'}],findingState:'CONSISTENT'},
   {channel:'condition',sourceRefs:[{sourceId:'outbound'},{sourceId:'return'}],findingState:'DIFFERENCE_OBSERVED'}]);
  expect(result.findingState).toBe('INCONCLUSIVE');expect(result.coverage).toMatchObject({unresolvedConflict:true,physicalCorrespondenceQualified:false});expect(result).not.toHaveProperty('probability');
 });
});
