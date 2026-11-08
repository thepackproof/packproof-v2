import { DomainError } from '../domain/errors.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';

export const CSV_LIMITS = { bytes: 2 * 1024 * 1024, rows: 1000, columns: 50, cellLength: 10000 } as const;
export const CSV_MAPPING_FIELDS = ['shipmentReference','itemTitle','quantity','trackingNumber','carrier','shippedAt','locationId'] as const;
export type CsvMappingField = typeof CSV_MAPPING_FIELDS[number];
export type CsvMapping = Partial<Record<CsvMappingField, string>>;
export type ImportRowStatus = 'valid' | 'invalid' | 'duplicate' | 'ambiguous' | 'imported' | 'failed';
export interface ShipmentCsvRow {
  rowNumber: number;
  status: ImportRowStatus;
  values: Record<string, string>;
  errors: string[];
  normalized: { shipmentReference: string; itemTitle: string; quantity: number; trackingNumber: string | null; carrier: string | null; shippedAt: string | null; shipmentDate: string | null; locationId: string | null } | null;
  payloadSha256: string | null;
  proofId?: string;
}
export interface ParsedShipmentCsv {
  headers: string[];
  mapping: CsvMapping;
  delimiter: ',' | ';' | '\t';
  encoding: 'UTF-8';
  timeZone: string;
  rows: ShipmentCsvRow[];
}

const aliases: Record<CsvMappingField, string[]> = {
  shipmentReference: ['shipmentreference','shipmentid','shipmentnumber','orderreference','orderid','ordernumber','reference'],
  itemTitle: ['itemtitle','description','product','item','title'],
  quantity: ['quantity','qty','units'],
  trackingNumber: ['trackingnumber','tracking','trackingid'],
  carrier: ['carrier','shippingcarrier'],
  shippedAt: ['shippedat','shipmentdate','shipdate','shippeddate'],
  locationId: ['locationid','location'],
};
const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A bounded RFC-4180 parser. No evaluation, number coercion or HTML parsing. */
export function parseCsv(csv: string, delimiter: ',' | ';' | '\t'): string[][] {
  const output: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closedQuote = false;
  const finishField = () => { if (field.length > CSV_LIMITS.cellLength) throw invalid('A spreadsheet cell exceeds the 10,000 character limit.'); row.push(field); field = ''; closedQuote = false; };
  const finishRow = () => {
    finishField();
    if (row.length > CSV_LIMITS.columns) throw invalid('Use at most 50 spreadsheet columns.');
    output.push(row); row = [];
    if (output.length > CSV_LIMITS.rows + 1) throw invalid('Split the spreadsheet into files of at most 1,000 rows.');
  };
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '\0') throw invalid('The spreadsheet contains a null character. Save it as UTF-8 CSV and upload again.');
    if (quoted) {
      if (c === '"') { if (csv[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closedQuote = true; } }
      else field += c;
    } else if (c === delimiter) finishField();
    else if (c === '\n' || c === '\r') { if (c === '\r' && csv[i + 1] === '\n') i++; finishRow(); }
    else if (c === '"') {
      if (field || closedQuote) throw invalid('A quote appears inside an unquoted cell. Save the spreadsheet as CSV and upload again.');
      quoted = true;
    } else { if (closedQuote) throw invalid('Unexpected text follows a closing quote. Save the spreadsheet as CSV and upload again.'); field += c; }
  }
  if (quoted) throw invalid('A quoted cell is unfinished. Save the spreadsheet as CSV and upload again.');
  if (field || row.length || closedQuote) finishRow();
  // Ignore only completely empty trailing lines; empty rows inside a file are errors.
  while (output.length && output[output.length - 1].every(cell => cell === '')) output.pop();
  return output;
}
function invalid(message: string) { return new DomainError('INVALID_CSV', message, 400); }

export function parseShipmentCsv(csv: unknown, mappingInput: unknown, timeZoneInput: unknown): ParsedShipmentCsv {
  if (typeof csv !== 'string' || !csv.length) throw invalid('Choose a UTF-8 CSV spreadsheet to upload.');
  if (Buffer.from(csv,'utf8').toString('utf8') !== csv) throw invalid('The spreadsheet contains invalid Unicode. Save it as UTF-8 CSV and upload again.');
  if (Buffer.byteLength(csv, 'utf8') > CSV_LIMITS.bytes) throw new DomainError('CSV_TOO_LARGE', 'Use a CSV file no larger than 2 MiB.', 413);
  if (typeof timeZoneInput !== 'string' || !timeZoneInput.length || timeZoneInput.length > 100) throw new DomainError('TIME_ZONE_REQUIRED', 'Choose the source location time zone before previewing the spreadsheet.', 400);
  try { new Intl.DateTimeFormat('en-US', { timeZone: timeZoneInput }).format(); }
  catch { throw new DomainError('INVALID_TIME_ZONE', 'Choose a valid IANA time zone, such as America/New_York or UTC.', 400); }
  const source = csv.replace(/^\uFEFF/, '');
  const candidates = ([',',';','\t'] as const).map(delimiter => {
    try { const parsed = parseCsv(source, delimiter); return { delimiter, parsed, score: parsed[0]?.length ?? 0 }; }
    catch { return { delimiter, parsed: null, score: -1 }; }
  }).sort((a,b) => b.score - a.score);
  if (!candidates[0].parsed) return parseCsv(source, ',') as never;
  const { delimiter, parsed } = candidates[0];
  if (!parsed || parsed.length < 2) throw invalid('Include a header row and at least one shipment row.');
  const headers = parsed[0].map(value => value.trim());
  if (headers.some(header => !header || header.length > 200)) throw invalid('Every spreadsheet column needs a nonempty header of at most 200 characters.');
  if (new Set(headers).size !== headers.length) throw invalid('Two columns have the same heading. Rename one so the mapping is unambiguous.');
  const mapping: CsvMapping = {};
  const mappingProblems: string[] = [];
  if (mappingInput !== undefined && mappingInput !== null) {
    if (typeof mappingInput !== 'object' || Array.isArray(mappingInput)) throw new DomainError('INVALID_MAPPING','Choose a spreadsheet column for each mapped field.',400);
    for (const [field, header] of Object.entries(mappingInput)) {
      if (!(CSV_MAPPING_FIELDS as readonly string[]).includes(field) || typeof header !== 'string' || !headers.includes(header)) throw new DomainError('INVALID_MAPPING', 'Every mapping must name a documented field and an exact spreadsheet heading.',400);
      mapping[field as CsvMappingField] = header;
    }
  } else {
    for (const field of CSV_MAPPING_FIELDS) {
      const matches = headers.filter(header => aliases[field].includes(key(header)));
      if (matches.length === 1) mapping[field] = matches[0];
      else if (matches.length > 1) mappingProblems.push(`Choose which column identifies ${field}; more than one heading matches.`);
    }
  }
  if (!mapping.shipmentReference) mappingProblems.push('Choose the column that identifies the shipment or order.');
  const rows: ShipmentCsvRow[] = parsed.slice(1).map((cells, index) => {
    const rowNumber = index + 2;
    const values = Object.fromEntries(headers.map((header, i) => [header, cells[i] ?? '']));
    const errors = [...mappingProblems];
    if (cells.length !== headers.length) errors.push(`Row ${rowNumber} has ${cells.length} cells but the header has ${headers.length}.`);
    const value = (field: CsvMappingField) => mapping[field] ? (values[mapping[field]!] ?? '').trim() : '';
    const shipmentReference = value('shipmentReference');
    if (!shipmentReference) errors.push(`Row ${rowNumber} is missing a shipment reference. Choose the correct column or add a reference and upload again.`);
    if (shipmentReference.length > 200) errors.push(`Row ${rowNumber} shipment reference exceeds 200 characters.`);
    const itemTitle = value('itemTitle') || `Shipment ${shipmentReference}`;
    if (itemTitle.length > 200) errors.push(`Row ${rowNumber} description exceeds 200 characters.`);
    const quantityText = value('quantity');
    const quantity = quantityText ? Number(quantityText) : 1;
    if (quantityText && (!/^\d+$/.test(quantityText) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000)) errors.push(`Row ${rowNumber} quantity must be a whole number from 1 to 100,000; decimal conventions are not inferred.`);
    const trackingNumber = value('trackingNumber') || null, carrier = value('carrier') || null;
    if ((trackingNumber?.length ?? 0) > 200 || (carrier?.length ?? 0) > 200) errors.push(`Row ${rowNumber} tracking and carrier fields may contain at most 200 characters.`);
    const shippedAt = value('shippedAt') || null;
    let shipmentDate: string | null = null, ambiguous = false;
    if (shippedAt) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(shippedAt) && !Number.isNaN(Date.parse(shippedAt)) && new Date(shippedAt).toISOString().slice(0,10) === shippedAt) shipmentDate = shippedAt;
      else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(shippedAt) && !Number.isNaN(Date.parse(shippedAt)) && new Date(`${shippedAt.slice(0,10)}T00:00:00Z`).toISOString().slice(0,10)===shippedAt.slice(0,10)) {
        const parts = new Intl.DateTimeFormat('en-US',{timeZone:timeZoneInput,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(shippedAt));
        const part = (name: string) => parts.find(p => p.type === name)!.value;
        shipmentDate = `${part('year')}-${part('month')}-${part('day')}`;
      } else { ambiguous = true; errors.push(`Row ${rowNumber} shipment date is ambiguous. Use YYYY-MM-DD or an ISO timestamp with an explicit UTC offset. The selected source time zone is ${timeZoneInput}.`); }
    }
    const locationId = value('locationId') || null;
    const normalized = errors.length ? null : { shipmentReference,itemTitle,quantity,trackingNumber,carrier,shippedAt,shipmentDate,locationId };
    return {rowNumber,status:errors.length ? (ambiguous || mappingProblems.length ? 'ambiguous' : 'invalid') : 'valid',values,errors,normalized,payloadSha256:normalized ? sha256Hex(canonicalize(normalized)) : null};
  });
  const identities = new Map<string, ShipmentCsvRow[]>();
  for (const row of rows) if (row.normalized) { const ref = canonicalize([row.normalized.locationId,row.normalized.shipmentReference]); identities.set(ref,[...(identities.get(ref) ?? []),row]); }
  for (const matches of identities.values()) if (matches.length > 1) {
    if (matches.some(row => row.payloadSha256 !== matches[0].payloadSha256)) {
      for (const row of matches) { row.status = 'ambiguous'; row.errors.push('This shipment reference appears more than once with different details. Resolve the conflicting rows before importing.'); }
    } else for (const row of matches.slice(1)) { row.status = 'duplicate'; row.errors.push('This row repeats an identical shipment in this file.'); }
  }
  return {headers,mapping,delimiter,encoding:'UTF-8',timeZone:timeZoneInput,rows};
}

/** Prefix dangerous spreadsheet formulas; quoting alone does not prevent execution. */
export function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g,'""')}"`;
}
export function correctionCsv(headers: string[], rows: ShipmentCsvRow[]): string {
  const uniqueHeader=(base:string)=>{let candidate=base;while(headers.includes(candidate))candidate=`_${candidate}`;return candidate;};
  return [[...headers,uniqueHeader('_PackProof row'),uniqueHeader('_PackProof issues')].map(csvCell).join(','),...rows.filter(row => ['invalid','ambiguous','failed'].includes(row.status)).map(row => [...headers.map(header => row.values[header]),row.rowNumber,row.errors.join(' ')].map(csvCell).join(','))].join('\r\n') + '\r\n';
}
export const SHIPMENT_CSV_TEMPLATE = 'Shipment reference,Description,Quantity,Tracking number,Carrier,Shipment date\r\nSAMPLE-0001,Example shipment,1,000123456789,Example carrier,2026-11-04\r\n';
