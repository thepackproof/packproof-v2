import type {AgentRestriction} from './agent-restrictions.js';
import type {ParsedShipmentCsv} from './csv.js';
import {analyzeColumns, CSV_RULES, shipmentInterpretation} from './csv-semantics.js';

/** Best-effort comparison on a newly admitted legacy original. Deliberately
 * accepts no database, storage, credentials or scheduler. Its output consists
 * entirely of fixed vocabulary and bounded counts. */
export function observeShipmentInterpretation(source: AgentRestriction | null, parsed: ParsedShipmentCsv) {
  const approved = source?.approved_config;
  if (!source || !approved?.sourceContract || approved.sourceContract.interpretationVersion) return;
  const scopes = process.env.PACKPROOF_SHIPMENT_INTERPRETATION_SHADOW_SOURCES?.split(',') ?? [];
  if (!scopes.some(scope => scope.trim() === `${source.id}:${source.config_revision}`)) return;

  const common = {event:'scheduled_csv_interpretation_shadow',rulesVersion:CSV_RULES.interpretation.version,rowCount:parsed.rows.length};
  // A failure of the observer or log sink must never affect the receipt.
  try {
    let summary: object;
    try {
      const rows = parsed.rows.map(row => row.values);
      const fields = analyzeColumns(parsed.headers, rows, undefined, [], approved.locationId, true, true);
      const policy = shipmentInterpretation(parsed.headers, rows, fields);
      const mapped = fields.filter(field => field.state === 'validated' && field.origin === 'source_column');
      const agree = mapped.filter(field => approved.mapping[field.field] === field.sourceColumnId).length;
      const abstain = fields.filter(field => field.state !== 'validated' && (field.state !== 'missing_optional' || !!approved.mapping[field.field])).length;
      summary = {outcome:policy.outcome,agreeingFields:agree,differentFields:mapped.length-agree,abstainedFields:abstain,reasonCodes:policy.reasonCodes};
    } catch {
      summary = {outcome:'evaluation_unavailable'};
    }
    console.info(JSON.stringify({...common,...summary}));
  } catch { /* Observation is outside the admission and receipt transaction. */ }
}
