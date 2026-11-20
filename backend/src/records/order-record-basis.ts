import {sha256Hex} from '../hash.js';
import type {OrderRecord} from './order-projection.js';

// Whole-export bytes can change when a different order is appended. Compare
// only the original record at a supported locator, independently of its name,
// row number, file modification time and collector's receipt time.
export function recordBytes(file: string, bytes: Buffer, records: Pick<OrderRecord,'locator'|'eventId'>[]) {
  const result = new Map<string,string>();
  if (!records.length) return result;
  const wanted = new Set(records.map(r=>r.locator));
  if (/\.(?:csv|tsv|psv)$/i.test(file) && !bytes.includes(0)) {
    let start=0, line=1, firstLine=1, quoted=false;
    for (let i=0;i<=bytes.length;i++) {
      const ch=bytes[i];
      if (ch===34) {
        if (quoted && bytes[i+1]===34) i++;
        else quoted=!quoted;
      }
      if (i!==bytes.length && ch!==10 && ch!==13) continue;
      if (!quoted) {
        const locator='line '+firstLine;
        if (wanted.has(locator)) result.set(locator,sha256Hex(bytes.subarray(start,i)));
      }
      if (ch===13 && bytes[i+1]===10) i++;
      line++;
      if (!quoted) { start=i+1;firstLine=line; }
    }
  } else if (/\.(?:ndjson|jsonl)$/i.test(file)) {
    for (const {locator} of records) {
      const m=/^byte\[(\d+),(\d+)\)$/.exec(locator);
      if (!m) continue;
      const from=Number(m[1]),to=Number(m[2]);
      if (from>=0 && from<to && to<=bytes.length && (from===0 || bytes[from-1]===10) && bytes[to-1]===10)
        result.set(locator,sha256Hex(bytes.subarray(from,to)));
    }
  } else if (/\.json$/i.test(file) && records.length === 1) {
    // A mapped canonical single-event JSON envelope includes its entire
    // original. Arbitrary nested reports require their own qualified locator.
    try {
      const json:unknown=JSON.parse(bytes.toString('utf8'));
      const obj=Array.isArray(json) && json.length===1 ? json[0] : json;
      if (obj && typeof obj==='object' && !Array.isArray(obj) && 'eventId' in obj && obj.eventId===records[0].eventId)
        result.set(records[0].locator,sha256Hex(bytes));
    } catch { /* Unsupported input still retains its original and normalized identity. */ }
  }
  return result;
}
