import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { evaluate, type Manifest } from '../scripts/evaluate-shipment-interpretations.js';

const fixture = (): Manifest => JSON.parse(readFileSync(new URL('./fixtures/shipment-evaluation-example.json',import.meta.url),'utf8'));

describe('offline shipment interpretation evaluation', () => {
  it('scores actual decisions, with abstentions and unsupported files in the offered denominator', () => {
    expect(evaluate(fixture())).toMatchObject({
      offeredFiles:6, familyCount:5, outcomes:{automatic:2,needs_review:1,blocked:2,unsupported:1},
      abstainedFiles:4, automaticFields:8, correctFields:8, expectedFields:14,
      automaticFieldPrecision:1, fieldCoverage:8/14, criticalErrors:0, errors:[]
    });
  });
  it('counts a plausible but independently mislabeled shipment number as a critical mapping error', () => {
    const manifest=fixture(), sample=manifest.samples[0];
    sample.csv=sample.csv.replace('Shipment ID,','Shipment ID,Dispatch key,').replace('000079,','000079,S-503,');
    sample.expected.fields.shipmentReference='Dispatch key';
    const result=evaluate(manifest);
    expect(result.automaticFieldPrecision).toBe(7/8);
    expect(result.criticalErrors).toBe(1);
    expect(result.errors).toContainEqual({sample:sample.id,field:'shipmentReference',code:'incorrect_automatic_field'});
    expect(JSON.stringify(result)).not.toContain('S-503');
    sample.expected.outcome='needs_review';
    expect(evaluate(manifest).criticalErrors).toBe(2);
  });
  it('rejects shared development families, repeated files, and development bytes under a changed family name', () => {
    const manifest=fixture();
    manifest.developmentFamilies.push(manifest.samples[0].family);
    expect(()=>evaluate(manifest)).toThrow('overlap');
    manifest.developmentFamilies.pop();
    const hash=createHash('sha256').update(manifest.samples[0].csv).digest('hex');
    expect(()=>evaluate(manifest,new Set([hash]))).toThrow('overlap');
    manifest.samples[1].csv=manifest.samples[0].csv;
    expect(()=>evaluate(manifest)).toThrow('duplicated');
  });
  it('reports precision as unavailable when the policy makes no automatic assignments', () => {
    const manifest=fixture();
    manifest.samples=manifest.samples.filter(s=>s.expected.outcome!=='automatic');
    expect(evaluate(manifest)).toMatchObject({automaticFieldPrecision:null,automaticFileCoverage:0,criticalErrors:0});
  });
});
