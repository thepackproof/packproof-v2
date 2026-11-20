import { DomainError } from '../domain/errors.js';

const steps = ['release', 'pick', 'pack', 'weigh', 'label', 'handoff', 'delivery', 'return'];
const labels = ['Shipped At', 'Carton', 'Weight', 'Unit', 'Order', 'Tracking', 'Delivered At', 'Other'];
const meanings = ['label_printed', 'carrier_handoff', 'carton_weight', 'delivery', 'unknown'];
const operations = ['ask_question', 'map_field', 'suggest_step', 'mark_unknown'];
const reasons = ['ambiguous_time', 'recognized_field', 'missing_unit', 'missing_step'];
interface SampleField { handle: string; label: string; type: string }
export interface SetupInput { draftId: string; revision: number; steps: string[]; fields: SampleField[] }
interface Suggestion { operation: string; step: string; field: string | null; meaning: string; reason: string }

function bad(): never { throw new DomainError('INVALID_SETUP_SUGGESTION', 'Review the permitted setup fields or continue manually.', 400); }
function exactly(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad();
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) return bad();
  return record;
}
function choice(value: unknown, allowed: string[]): string {
  if (typeof value !== 'string' || !allowed.includes(value)) return bad();
  return value;
}
export function readSetupInput(input: unknown): SetupInput {
  const v = exactly(input, ['draftId', 'revision', 'consent', 'steps', 'fields']);
  if (v.consent !== true || typeof v.draftId !== 'string' ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v.draftId) ||
      typeof v.revision !== 'number' || !Number.isSafeInteger(v.revision) || v.revision < 1 || v.revision > 2147483647 ||
      !Array.isArray(v.steps) || !v.steps.length || v.steps.length > steps.length ||
      !Array.isArray(v.fields) || !v.fields.length || v.fields.length > 64) return bad();
  const selected = v.steps.map(step => choice(step, steps));
  const fields = v.fields.map(raw => {
    const field = exactly(raw, ['handle', 'label', 'type']);
    if (typeof field.handle !== 'string' || !/^f(?:[1-9]|[1-5][0-9]|6[0-4])$/.test(field.handle)) return bad();
    return { handle: field.handle, label: choice(field.label, labels), type: choice(field.type, ['text', 'number', 'datetime']) };
  });
  if (new Set(selected).size !== selected.length || new Set(fields.map(f => f.handle)).size !== fields.length) return bad();
  return { draftId: v.draftId.toLowerCase(), revision: v.revision, steps: selected, fields };
}
export function validateSuggestions(value: unknown, input: SetupInput): Suggestion[] {
  const { suggestions } = exactly(value, ['suggestions']);
  if (!Array.isArray(suggestions) || suggestions.length > 6) return bad();
  return suggestions.map(raw => {
    const s = exactly(raw, ['operation', 'step', 'field', 'meaning', 'reason']);
    const operation = choice(s.operation, operations);
    const step = choice(s.step, operation === 'suggest_step' ? steps.filter(key => !input.steps.includes(key)) : input.steps);
    const meaning = choice(s.meaning, meanings);
    const field = s.field === null && operation === 'suggest_step' ? null : choice(s.field, input.fields.map(f => f.handle));
    if (operation === 'mark_unknown' && meaning !== 'unknown' || operation === 'map_field' && meaning === 'unknown') return bad();
    const basis = input.fields.find(f => f.handle === field);
    // Ambiguous timestamps, masked headings and missing units require a human answer.
    if (operation === 'map_field' && !(basis?.label === 'Delivered At' && basis.type === 'datetime' && meaning === 'delivery' ||
        basis?.label === 'Weight' && basis.type === 'number' && input.fields.some(f => f.label === 'Unit') && meaning === 'carton_weight')) return bad();
    return { operation, step, field, meaning, reason: choice(s.reason, reasons) };
  });
}
export async function requestSuggestions(input: SetupInput, fetcher: typeof fetch = fetch) {
  const key = process.env.PACKPROOF_SETUP_AI_KEY, model = process.env.PACKPROOF_SETUP_AI_MODEL;
  if (!key || !model || process.env.PACKPROOF_SETUP_AI_PROVIDER !== 'openai') throw Error('Provider unavailable');
  const response = await fetcher('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000), body: JSON.stringify({
      model, store: false, max_completion_tokens: 350, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: 'Suggest warehouse setup questions. Reply as JSON with a suggestions array of at most 3 objects with operation, step, field, meaning, reason. operation: '+ operations.join(', ') + '. step must be supplied, or for suggest_step a missing step in '+ steps.join(', ') +'. field is a supplied handle, or null for suggest_step. meaning: '+ meanings.join(', ') + '. reason: '+ reasons.join(', ') + '. Ask about ambiguous timestamps and unknown units. Never resolve ambiguity yourself.' },
        { role: 'user', content: JSON.stringify({ steps: input.steps, fields: input.fields }) }]
    })
  });
  if (!response.ok) throw Error('Provider unavailable');
  const value = await response.json() as { choices?: { message?: { content?: string; refusal?: string } }[]; usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } };
  const message = value.choices?.[0]?.message;
  if (!message?.content || message.refusal || message.content.length > 8192) throw Error('No valid suggestion');
  const usage = value.usage;
  const rates = [process.env.PACKPROOF_SETUP_AI_INPUT_USD_PER_MILLION,process.env.PACKPROOF_SETUP_AI_OUTPUT_USD_PER_MILLION];
  const priced = rates.every(rate => rate?.trim() && Number.isFinite(Number(rate)) && Number(rate)>=0) &&
    Number.isSafeInteger(usage?.prompt_tokens) && Number.isSafeInteger(usage?.completion_tokens);
  const costMicrousd = priced ? Math.round(usage!.prompt_tokens!*Number(rates[0]) + usage!.completion_tokens!*Number(rates[1])) : null;
  return { suggestions: validateSuggestions(JSON.parse(message.content), input), tokens: Math.max(0, Math.min(16384, Number(usage?.total_tokens) || 0)),costMicrousd };
}
