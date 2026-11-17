// Offline scored evaluation. The result contains pseudonymous IDs and counts only.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseShipmentCsv } from '../src/records/csv.js';
import { analyzeColumns, CSV_RULES, shipmentInterpretation, type SemanticField } from '../src/records/csv-semantics.js';
import { DomainError } from '../src/domain/errors.js';

type Outcome = 'automatic' | 'needs_review' | 'blocked' | 'unsupported';
interface Sample {
  id: string;
  family: string;
  csv: string;
  expected: { outcome: Outcome; fields: Partial<Record<SemanticField, string>> };
}
export interface Manifest {
  schema: 'packproof.shipment-evaluation/v1';
  population: 'synthetic' | 'deidentified';
  benchmarkId: string;
  labelingReference: string;
  developmentFamilies: string[];
  samples: Sample[];
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const identifier = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value);
const outcomes: Outcome[] = ['automatic','needs_review','blocked','unsupported'];
const critical = new Set<SemanticField>(['shipmentReference','quantity','shippedAt','locationId','trackingNumber']);

function evaluateCsv(csv: string) {
  try {
    const parsed = parseShipmentCsv(csv, undefined, 'source-offset');
    const rows = parsed.rows.map(row => row.values);
    const decisions = analyzeColumns(parsed.headers, rows, undefined, [], null, true, true);
    const interpretation = shipmentInterpretation(parsed.headers, rows, decisions);
    const outcome = interpretation.outcome === 'automatic' && parsed.rows.some(row => row.status !== 'valid') ? 'blocked' : interpretation.outcome;
    return { outcome, decisions, headers: parsed.headers };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { outcome: 'unsupported', decisions: [], headers: [] };
  }
}

export function evaluate(manifest: Manifest, developmentDigests: ReadonlySet<string> = new Set()) {
  if (manifest.schema !== 'packproof.shipment-evaluation/v1' || !['synthetic','deidentified'].includes(manifest.population)
      || !identifier(manifest.benchmarkId) || !identifier(manifest.labelingReference)
      || !Array.isArray(manifest.developmentFamilies) || !manifest.developmentFamilies.length
      || !manifest.developmentFamilies.every(identifier) || !Array.isArray(manifest.samples) || !manifest.samples.length)
    throw new Error('Supply a versioned manifest with a population, pseudonymous benchmark/label references, development families and held-out samples.');
  const seen = new Set<string>();
  const originals = new Set<string>();
  const families = new Map<string, number>();
  const disposition = {automatic:0, needs_review:0, blocked:0, unsupported:0};
  const errors: Array<{sample:string; field?:string; code:string}> = [];
  let automaticFields = 0, correctFields = 0, expectedFields = 0, assignedExpectedFields = 0, criticalErrors = 0;
  for (const sample of manifest.samples) {
    if (!identifier(sample.id) || !identifier(sample.family) || !sample.expected || !outcomes.includes(sample.expected.outcome)
        || typeof sample.csv !== 'string' || !sample.expected.fields || typeof sample.expected.fields !== 'object'
        || Array.isArray(sample.expected.fields) || Object.entries(sample.expected.fields).some(([field,column]) =>
          !Object.hasOwn(CSV_RULES.aliases,field) || typeof column !== 'string' || !column.length))
      throw new Error('Invalid evaluation sample or ground-truth fields.');
    if (sample.expected.outcome === 'automatic' && CSV_RULES.required.some(field => !Object.hasOwn(sample.expected.fields,field)))
      throw new Error('An automatically admissible label must identify every required shipment field.');
    const hash = digest(sample.csv);
    if (seen.has(sample.id) || originals.has(hash)) throw new Error('A sample or original is duplicated.');
    if (manifest.developmentFamilies.includes(sample.family) || developmentDigests.has(hash)) throw new Error('Development and holdout inputs overlap.');
    seen.add(sample.id); originals.add(hash);
    families.set(sample.family,(families.get(sample.family) ?? 0) + 1);
    const prediction = evaluateCsv(sample.csv);
    if (prediction.outcome !== 'unsupported' && Object.values(sample.expected.fields).some(column => !prediction.headers.includes(column)))
      throw new Error('A labeled column does not exist in the original.');
    disposition[prediction.outcome as Outcome]++;
    expectedFields += Object.keys(sample.expected.fields).length;
    if (prediction.outcome !== sample.expected.outcome) {
      errors.push({ sample:sample.id, code:`expected_${sample.expected.outcome}_observed_${prediction.outcome}` });
      if (prediction.outcome === 'automatic') criticalErrors++;
    }
    if (prediction.outcome !== 'automatic') continue;
    for (const field of prediction.decisions) {
      if (field.state !== 'validated' || field.origin !== 'source_column') continue;
      automaticFields++;
      const target = sample.expected.fields[field.field];
      if (target !== undefined) assignedExpectedFields++;
      if (field.sourceColumnId === target) correctFields++;
      else {
        if (critical.has(field.field)) criticalErrors++;
        errors.push({sample:sample.id, field:field.field, code:'incorrect_automatic_field'});
      }
    }
    for (const field of Object.keys(sample.expected.fields)) {
      if (!prediction.decisions.some(item => item.field === field && item.state === 'validated'))
        errors.push({sample:sample.id, field, code:'expected_field_unmapped'});
    }
  }
  return { benchmarkId:manifest.benchmarkId, population:manifest.population, labelingReference:manifest.labelingReference,
    rulesVersion:CSV_RULES.version, interpretationVersion:CSV_RULES.interpretation.version,
    offeredFiles:seen.size, familyCount:families.size, filesByFamily:Object.fromEntries(families), outcomes:disposition,
    abstainedFiles:seen.size-disposition.automatic, automaticFileCoverage:disposition.automatic/seen.size,
    automaticFields, correctFields, expectedFields, assignedExpectedFields,
    automaticFieldPrecision:automaticFields ? correctFields/automaticFields : null,
    fieldCoverage:expectedFields ? assignedExpectedFields/expectedFields : null, criticalErrors, errors };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [file, expectedDigest] = process.argv.slice(2);
  if (!file) throw new Error('Usage: node --import tsx scripts/evaluate-shipment-interpretations.ts manifest.json [frozen-sha256]');
  const original = readFileSync(file,'utf8');
  const manifestSha256 = digest(original);
  if (expectedDigest && expectedDigest !== manifestSha256) throw new Error('The frozen evaluation manifest has changed.');
  const corpus: Array<{csv:string}> = JSON.parse(readFileSync(new URL('../tests/fixtures/connect-csv-corpus.json',import.meta.url),'utf8'));
  const result = evaluate(JSON.parse(original), new Set(corpus.map(f => digest(f.csv))));
  console.log(JSON.stringify({manifestSha256,...result},null,2));
  if (result.errors.length) process.exitCode = 2;
}
