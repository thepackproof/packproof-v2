import { GS1_DICTIONARY_REVISION, GS1_DICTIONARY_ROWS } from './gs1/dictionary.js';
import { recognizeShippingBarcode } from '../capture/shipping-barcode.js';
import type { IdentifierClassification, ParsedIdentifier } from './types.js';

/** Pure shared parsing. No network, platform decoder, Node API, or product lookup. */
export const IDENTIFIER_CLASSIFIER_VERSION = 'packproof-identifiers/1.0.0';
export const IDENTIFIER_PARSER_VERSION = `gs1-subset/1.0.1@${GS1_DICTIONARY_REVISION}`;
export const IDENTIFIER_LIMITS = Object.freeze({ rawTextBytes: 4096, requestBytes: 128 * 1024,
  batchEvents: 50, sessionEvents: 512, reservedOpaqueEvents: 32, maxStructuredFields: 64 });

/** UTF-8 byte length without Buffer/TextEncoder (also runs in native Hermes). */
export function identifierUtf8Bytes(value: string): number {
  let bytes = 0;
  for (const char of value) { const cp = char.codePointAt(0)!; bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4; }
  return bytes;
}

export function normalizeSymbology(value: string): string {
  const name = value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const aliases: Record<string, string> = {
    EAN13:'EAN_13', EAN8:'EAN_8', UPCA:'UPC_A', UPCE:'UPC_E', QRCODE:'QR_CODE', QR:'QR_CODE',
    DATAMATRIX:'DATA_MATRIX', CODE128:'CODE_128', CODE39:'CODE_39', CODE93:'CODE_93',
    PDF417:'PDF_417', CODABAR:'CODABAR', AZTEC:'AZTEC', ITF:'ITF', ITF14:'ITF_14',
    INTERLEAVED2OF5:'ITF', GS1128:'GS1_128', GS1DATAMATRIX:'GS1_DATA_MATRIX',
    GS1QRCODE:'GS1_QR_CODE', DATABAR:'GS1_DATABAR', GS1DATABAR:'GS1_DATABAR',
    DATABAREXPANDED:'GS1_DATABAR_EXPANDED', GS1DATABAREXPANDED:'GS1_DATABAR_EXPANDED',
  };
  return aliases[name] ?? name;
}

export function validGs1CheckDigit(value: string): boolean {
  if (!/^\d+$/.test(value) || value.length < 2) return false;
  let sum = 0;
  for (let i = value.length - 2, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) sum += Number(value[i]) * weight;
  return (10 - sum % 10) % 10 === Number(value[value.length - 1]);
}

/** Eight characters only: never invent a missing number-system/check digit.
 * Expansion verified against ZXing 3.5.3 UPCEReader.convertUPCEtoUPCA.
 */
export function expandUpce(value: string): string | null {
  if (!/^[01]\d{7}$/.test(value)) return null;
  const ns = value[0], digits = value.slice(1, 7), last = digits[5];
  const body = last <= '2' ? `${ns}${digits.slice(0, 2)}${last}0000${digits.slice(2, 5)}`
    : last === '3' ? `${ns}${digits.slice(0, 3)}00000${digits.slice(3, 5)}`
    : last === '4' ? `${ns}${digits.slice(0, 4)}00000${digits[4]}`
    : `${ns}${digits.slice(0, 5)}0000${last}`;
  const expanded = body + value[7];
  return validGs1CheckDigit(expanded) ? expanded : null;
}

/** GTIN identity is a string; packaging-level indicator digits remain significant. */
export function normalizeGtin(value: string, symbology?: string): string | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const format = normalizeSymbology(symbology ?? '');
  let candidate = value;
  if (format === 'UPC_E') { const expanded = expandUpce(value); if (!expanded) return null; candidate = expanded; }
  else if ((format === 'UPC_A' && value.length !== 12) || (format === 'EAN_8' && value.length !== 8)
    || (format === 'EAN_13' && value.length !== 13) || (format === 'ITF_14' && value.length !== 14)) return null;
  if (![8, 12, 13, 14].includes(candidate.length) || !validGs1CheckDigit(candidate)) return null;
  return candidate.padStart(14, '0');
}

interface Component { kind: string; min: number; max: number; optional: boolean; linters: string[] }
interface Definition { ai: string; predefined: boolean; dlAttribute: boolean; components: Component[];
  min: number; max: number; required: string[]; excludes: string[]; dlQualifiers: string[][] | null }

// Shape and association rules are compiled from the pinned official dictionary, never inferred from a barcode regex.
const definitions = new Map<string, Definition>();
for (const [range, flags, specification, attributes] of GS1_DICTIONARY_ROWS) {
  const components = specification.split(' ').map(token => {
    const m = /^(\[?)([NXYZ])(\.\.)?(\d+)\]?(?:,(.*))?$/.exec(token)!;
    const max = Number(m[4]);
    return { kind:m[2], min:m[1] ? 0 : m[3] ? 1 : max, max, optional:!!m[1], linters:m[5]?.split(',') ?? [] };
  });
  const attrs = attributes ? attributes.split(' ') : [];
  const dl = attrs.find(a => a === 'dlpkey' || a.startsWith('dlpkey='));
  const start = range.split('-')[0], end = range.split('-')[1] ?? start;
  for (let n = Number(start); n <= Number(end); n++) {
    const ai = String(n).padStart(start.length, '0');
    definitions.set(ai, { ai, predefined:flags.includes('*'), dlAttribute:flags.includes('?'), components,
      min:components.reduce((s,c) => s+c.min, 0), max:components.reduce((s,c) => s+c.max, 0),
      required:attrs.filter(a => a.startsWith('req=')).map(a => a.slice(4)),
      excludes:attrs.filter(a => a.startsWith('ex=')).flatMap(a => a.slice(3).split(',')),
      dlQualifiers:dl === undefined ? null : dl === 'dlpkey' ? [[]] : dl.slice(7).split('|').map(a => a.split(',')) });
  }
}

interface Field { ai: string; value: string; definition?: Definition }
interface Structured { fields: Field[]; reasonCodes: string[]; malformed: boolean; suppress?: boolean }
const gs = '\u001d';
const typedAis: Record<string, ParsedIdentifier['type']> = {
  '00':'SSCC', '01':'GTIN', '02':'CONTAINED_GTIN', '10':'LOT', '17':'EXPIRY', '21':'SERIAL',
};
const makeIdentifier = (type: ParsedIdentifier['type'], value: string, normalizedValue: string | null,
  validationResult: ParsedIdentifier['validationResult'], namespace: string | null): ParsedIdentifier =>
  ({ type, value, normalizedValue, namespace, validationResult, parserVersion:IDENTIFIER_PARSER_VERSION });
const fail = (reason: string, fields: Field[] = [], suppress = false): Structured => ({ fields, reasonCodes:[reason], malformed:true, suppress });

function aiAt(text: string, offset: number): Definition | undefined {
  for (const length of [4, 3, 2]) { const d = definitions.get(text.slice(offset, offset + length)); if (d) return d; }
  return undefined;
}

function parseElements(text: string): Structured {
  const fields: Field[] = [];
  const hri = text.startsWith('(');
  let offset = 0;
  while (offset < text.length && fields.length < IDENTIFIER_LIMITS.maxStructuredFields) {
    if (text[offset] === gs) return fail('GS1_UNEXPECTED_SEPARATOR', fields);
    let ai: string, d: Definition | undefined;
    if (hri) {
      const m = /^\((\d{2,4})\)/.exec(text.slice(offset));
      if (!m) return fail('GS1_MALFORMED_HRI', fields);
      ai = m[1]; d = definitions.get(ai); offset += m[0].length;
    } else {
      d = aiAt(text, offset);
      if (!d) return fail('GS1_UNSUPPORTED_AI_BOUNDARY', fields);
      ai = d.ai; offset += ai.length;
    }
    let end: number;
    if (hri) {
      const tail = text.slice(offset); const next = /\(\d{2,4}\)/.exec(tail);
      end = next ? offset + next.index : text.length;
    } else if (d!.predefined) end = offset + d!.max;
    else { const separator = text.indexOf(gs, offset); end = separator < 0 ? text.length : separator; }
    if (end > text.length) return fail('GS1_FIELD_LENGTH_INVALID', fields);
    const value = text.slice(offset, end);
    fields.push({ ai, value, definition:d }); offset = end;
    if (!hri && text[offset] === gs) { offset++; if (offset === text.length) return fail('GS1_TRAILING_SEPARATOR', fields); }
  }
  if (offset < text.length) return fail('GS1_FIELD_LIMIT', fields);
  return { fields, reasonCodes:[], malformed:false };
}

/** Offline, uncompressed numeric-AI Digital Link subset. Never dereferences the URI.
 * Credentials, fragments and non-GS1 query parameters are suppressed before persistence.
 */
function parseDigitalLink(text: string): Structured | null {
  const uri = /^https?:\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?(?:#(.*))?$/i.exec(text);
  if (!uri) return null;
  if (uri[1].includes('@') || uri[4] !== undefined || /[\s\\]/.test(uri[1])) return fail('UNRELATED_URL_SUPPRESSED', [], true);
  const path = (uri[2] ?? '').split('/').slice(1);
  const first = path.findIndex(segment => definitions.get(segment)?.dlQualifiers !== null && definitions.has(segment));
  if (first < 0) return null;
  const parts = path.slice(first);
  if (!parts.length || parts.length % 2) return fail('GS1_DIGITAL_LINK_PATH_INVALID', [], true);
  const fields: Field[] = [];
  try {
    for (let i = 0; i < parts.length; i += 2) {
      if (fields.length >= IDENTIFIER_LIMITS.maxStructuredFields) return fail('GS1_FIELD_LIMIT', [], true);
      const ai = parts[i];
      if (!/^\d{2,4}$/.test(ai)) return fail('GS1_DIGITAL_LINK_PATH_INVALID', [], true);
      fields.push({ ai, value:decodeURIComponent(parts[i + 1]), definition:definitions.get(ai) });
    }
    const primary = fields[0].definition;
    const qualifiers = fields.slice(1).map(f => f.ai);
    if (!primary?.dlQualifiers?.some(allowed => {
      let last = -1; return qualifiers.every(q => { const at = allowed.indexOf(q); const valid = at > last; last = at; return valid; });
    })) return fail('GS1_DIGITAL_LINK_QUALIFIER_INVALID', fields, true);
    if (uri[3] !== undefined) for (const part of uri[3].split('&')) {
      const split = part.indexOf('=');
      if (split < 1) return fail('UNRELATED_URL_SUPPRESSED', [], true);
      const ai = decodeURIComponent(part.slice(0, split)); const d = definitions.get(ai);
      if (!/^\d{2,4}$/.test(ai) || !d?.dlAttribute) return fail('UNRELATED_URL_SUPPRESSED', [], true);
      if (fields.length >= IDENTIFIER_LIMITS.maxStructuredFields) return fail('GS1_FIELD_LIMIT', [], true);
      fields.push({ ai, value:decodeURIComponent(part.slice(split + 1)), definition:d });
    }
  } catch { return fail('GS1_DIGITAL_LINK_ENCODING_INVALID', [], true); }
  return { fields, reasonCodes:['GS1_DIGITAL_LINK_OFFLINE'], malformed:false };
}

function validDate(value: string, dayZero: boolean): boolean {
  if (!/^\d{6}$/.test(value)) return false;
  const year = Number(value.slice(0, 2)), month = Number(value.slice(2, 4)), day = Number(value.slice(4, 6));
  const days = [31, year % 4 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= (dayZero ? 0 : 1) && day <= days[month - 1];
}

function validField(field: Field): boolean {
  const d = field.definition;
  if (!d || field.value.length < d.min || field.value.length > d.max) return false;
  let offset = 0;
  for (const c of d.components) {
    const remaining = field.value.length - offset;
    if (!remaining && c.optional) break;
    const size = Math.min(c.max, remaining); const value = field.value.slice(offset, offset + size); offset += size;
    if (size < c.min) return false;
    if (c.kind === 'N' && !/^\d+$/.test(value)) return false;
    // GS1 CSET 82 (X) excludes spaces, #, $, @, brackets, backslashes and braces.
    if (c.kind === 'X' && !/^[!"%&'()*+,\-./0-9:;<=>?A-Z_a-z]+$/.test(value)) return false;
    if (c.kind === 'Y' && !/^[#\-/0-9A-Z]+$/.test(value)) return false;
    if (c.kind === 'Z' && !/^[A-Za-z0-9_\-=]+$/.test(value)) return false;
    if (c.linters.includes('csum') && !validGs1CheckDigit(value)) return false;
    if (c.linters.includes('yymmd0') && !validDate(value, true)) return false;
    if (c.linters.includes('yymmdd') && !validDate(value, false)) return false;
  }
  return offset === field.value.length;
}

const patternMatches = (pattern: string, ai: string) => pattern.length === ai.length
  && [...pattern].every((char, i) => char === 'n' || char === ai[i]);

function interpretStructured(parsed: Structured): IdentifierClassification {
  const reasons = [...parsed.reasonCodes]; const present = parsed.fields.map(f => f.ai);
  const duplicates = new Set(present.filter((ai, i) => present.indexOf(ai) !== i));
  const exclusions = parsed.fields.some(f => f.definition?.excludes.some(p => present.some(ai => ai !== f.ai && patternMatches(p, ai))));
  if (duplicates.size) reasons.push('GS1_DUPLICATE_AI');
  if (exclusions) reasons.push('GS1_EXCLUSIVE_AI_COMBINATION');
  const identifiers = parsed.fields.map(field => {
    const type = typedAis[field.ai] ?? 'UNKNOWN'; const known = !!field.definition;
    const missing = field.definition?.required.some(rule => !rule.split(',').some(group => group.split('+').every(p => present.some(ai => patternMatches(p, ai))))) ?? false;
    if (missing) reasons.push(`GS1_AI_${field.ai}_REQUIRED_ASSOCIATION_MISSING`);
    if (!known || type === 'UNKNOWN') reasons.push(`GS1_AI_${field.ai}_UNSUPPORTED_ATTRIBUTE`);
    const valid = validField(field) && !parsed.malformed && !duplicates.has(field.ai) && !exclusions;
    if (known && !validField(field)) reasons.push(`GS1_AI_${field.ai}_VALUE_INVALID`);
    const validation: ParsedIdentifier['validationResult'] = !known || type === 'UNKNOWN' ? 'UNSUPPORTED'
      : !valid ? 'INVALID' : missing ? 'UNVERIFIED' : 'VALID';
    const normalized = validation !== 'VALID' ? null : type === 'GTIN' || type === 'CONTAINED_GTIN'
      ? normalizeGtin(field.value) : field.value;
    return makeIdentifier(type, field.value, normalized, validation, `GS1:${field.ai}`);
  });
  if (!identifiers.length && !reasons.length) reasons.push('GS1_EMPTY_PAYLOAD');
  return { kind:parsed.suppress ? 'UNSUPPORTED' : 'STRUCTURED', identifiers:parsed.suppress ? [] : identifiers,
    reasonCodes:[...new Set(reasons)], classifierVersion:IDENTIFIER_CLASSIFIER_VERSION };
}

function classifyInternal(input: { rawText: string; symbology: string; symbologyIdentifier?: string | null }): IdentifierClassification {
  const result = (kind: IdentifierClassification['kind'], reason: string, identifiers: ParsedIdentifier[] = []): IdentifierClassification =>
    ({ kind, identifiers, reasonCodes:[reason], classifierVersion:IDENTIFIER_CLASSIFIER_VERSION });
  const raw = input.rawText;
  if (!raw.length) return result('UNSUPPORTED', 'EMPTY_PAYLOAD');
  if (identifierUtf8Bytes(raw) > IDENTIFIER_LIMITS.rawTextBytes) return result('UNSUPPORTED', 'PAYLOAD_TOO_LARGE');
  if (/^\[UNSUPPORTED:[A-Z0-9_]+\]$/.test(raw)) return result('UNSUPPORTED', raw.slice(13, -1));
  if (/^(?:WIFI:|(?:BEGIN:)?VCARD|MECARD:|MATMSG:|mailto:|tel:|sms:|smsto:|geo:|bitcoin:|ethereum:|upi:|otpauth:|javascript:|data:)/i.test(raw.trimStart()))
    return result('UNSUPPORTED', 'SENSITIVE_PAYLOAD_SUPPRESSED');
  const possibleUrl = raw.trimStart();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(possibleUrl) || /^https?:/i.test(possibleUrl) || /^(?:\/\/|www\.)/i.test(possibleUrl)) {
    const digital = parseDigitalLink(possibleUrl);
    return digital ? interpretStructured(digital) : result('UNSUPPORTED', 'UNRELATED_URL_SUPPRESSED');
  }
  const symbology = normalizeSymbology(input.symbology);
  const aim = /^\][A-Za-z][0-9]/.exec(raw)?.[0] ?? input.symbologyIdentifier ?? '';
  const payload = raw.startsWith(aim) && aim.length === 3 ? raw.slice(3) : raw;
  // USPS uses postal AIs inside GS1-128. Preserve it for the scoped shipping/SKU
  // resolver instead of interpreting postal AIs as generic private product data.
  if (['CODE_128', 'GS1_128'].includes(symbology) && recognizeShippingBarcode(raw)?.carrierHint === 'USPS')
    return result('OPAQUE', 'SCOPED_RESOLUTION_REQUIRED', [makeIdentifier('UNKNOWN', raw, null, 'UNVERIFIED', null)]);
  const gs1 = [']C1', ']d2', ']Q3'].includes(aim) || ['GS1_128','GS1_DATA_MATRIX','GS1_QR_CODE','GS1_DATABAR_EXPANDED'].includes(symbology)
    || payload.startsWith(gs) || (payload.includes(gs) && !!aiAt(payload, 0)) || /^\(\d{2,4}\)/.test(payload);
  if (gs1) return interpretStructured(parseElements(payload.startsWith(gs) ? payload.slice(1) : payload));
  if (['UPC_A', 'UPC_E', 'EAN_8', 'EAN_13', 'ITF_14'].includes(symbology)
    || (symbology === 'ITF' && raw.length === 14 && normalizeGtin(raw))) {
    const gtin = normalizeGtin(raw, symbology);
    return result('PRODUCT', gtin ? 'VALIDATED_GTIN' : 'INVALID_GTIN',
      [makeIdentifier('GTIN', raw, gtin, gtin ? 'VALID' : 'INVALID', 'GS1')]);
  }
  if (/[\u0000-\u001f\u007f]/.test(raw)) return result('UNSUPPORTED', 'UNSUPPORTED_CONTROL_PAYLOAD');
  if (!['CODE_128','CODE_39','CODE_93','QR_CODE','DATA_MATRIX','ITF','CODABAR','PDF_417','AZTEC','GS1_DATABAR'].includes(symbology))
    return result('UNSUPPORTED', 'SYMBOLOGY_UNSUPPORTED');
  // An opaque value is not labelled SKU, serial, tracking, or order until the scoped resolver supplies its meaning.
  return result('OPAQUE', 'SCOPED_RESOLUTION_REQUIRED', [makeIdentifier('UNKNOWN', raw, null, 'UNVERIFIED', null)]);
}

export function classifyIdentifier(input: { rawText: string; symbology: string; symbologyIdentifier?: string | null }): IdentifierClassification {
  return classifyInternal(input);
}

/** Use on every ingress BEFORE durable storage, including the authoritative server. */
export function sanitizeIdentifierPayload<T extends { rawText: string; rawBytes?: string | null; symbology: string; symbologyIdentifier?: string | null }>(input: T): T {
  const classified = classifyIdentifier(input);
  const suppressed = classified.kind === 'UNSUPPORTED' && classified.reasonCodes.some(reason =>
    reason.includes('SUPPRESSED') || reason === 'PAYLOAD_TOO_LARGE' || reason === 'UNSUPPORTED_CONTROL_PAYLOAD'
      || reason.startsWith('GS1_DIGITAL_LINK') || reason === 'GS1_FIELD_LIMIT');
  return suppressed ? { ...input, rawText:`[UNSUPPORTED:${classified.reasonCodes[0]}]`, rawBytes:null } : { ...input };
}
