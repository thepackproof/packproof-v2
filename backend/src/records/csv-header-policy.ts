import {headerKey} from './csv-semantics.js';

export const CSV_REORDER_POLICY = 'same_names_any_order/v1';

// Release admission requires an explicitly enabled policy and the revision
// qualified on the ingestion worker. A missing declaration keeps exact ordering.
export function csvHeaderPolicyAvailable(collectorVersion: string | null) {
  return (collectorVersion === null || collectorVersion === '0.4.1') &&
    process.env.PACKPROOF_CSV_HEADER_VARIANTS_ENABLED === 'true' &&
    process.env.PACKPROOF_CSV_HEADER_WORKER_POLICY === CSV_REORDER_POLICY;
}

export function csvHeaderChange(expected: readonly string[], observed: readonly string[]) {
  if (expected.length === observed.length && expected.every((name, i) => observed[i] === name)) return 'exact';
  const approved = new Set(expected);
  if (observed.some(name => !approved.has(name))) return 'disclosure_changed';
  if (expected.length !== observed.length || new Set(observed).size !== expected.length) return 'schema_changed';
  if (new Set(expected.map(headerKey)).size !== expected.length) return 'schema_changed';
  return 'reordered';
}

export function approvedCsvHeaders(expected: readonly string[], observed: readonly string[], policy?: string) {
  const change = csvHeaderChange(expected, observed);
  if (policy !== undefined && policy !== CSV_REORDER_POLICY) return false;
  return change === 'exact' || change === 'reordered' && policy === CSV_REORDER_POLICY;
}
