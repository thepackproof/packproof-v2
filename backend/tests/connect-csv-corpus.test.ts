import { describe, it, expect } from 'vitest';
import {createHash} from 'node:crypto';
import {isUtf8} from 'node:buffer';
import { readFileSync } from 'node:fs';
import { analyzeColumns, shipmentInterpretation, CSV_RULES } from '../src/records/csv-semantics.js';
import { parseShipmentCsv } from '../src/records/csv.js';
import { validateScheduledCsvRows, validateScheduledCsvSourceContract } from '../src/records/agent-restrictions.js';
const corpus=JSON.parse(readFileSync(new URL('./fixtures/connect-csv-corpus.json',import.meta.url),'utf8')) as Array<{name:string;csv:string;ready:boolean;mapping?:Record<string,string>;confirmedFields?:string[];locationId?:string;parseError?:boolean;encodingError?:boolean;base64?:string;byteSha256?:string;repeat?:{unit:string;count:number;suffix:string};interpretation?:{outcome:string;grain:string;reasonCodes:string[]};fieldCounts?:Record<string,{valid:number;invalid:number}>}>;
describe('shared raw CSV semantic corpus (also run by the C# service)',()=>{
 for(const fixture of corpus)it(fixture.name,()=>{
  const repeated=fixture.repeat;
  const csv=fixture.csv+(repeated ? (repeated.unit.includes('{i}') ? Array.from({length:repeated.count},(_,i)=>repeated.unit.replace('{i}',String(i))).join('') : repeated.unit.repeat(repeated.count))+repeated.suffix : '');
  const bytes=fixture.base64 ? Buffer.from(fixture.base64,'base64') : Buffer.from(csv);
  if(fixture.byteSha256)expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.byteSha256);
  if(fixture.encodingError){expect(isUtf8(bytes)).toBe(false);return;}
  if(fixture.parseError){expect(()=>parseShipmentCsv(csv,fixture.mapping,'source-offset')).toThrow();return;}
  const parsed=parseShipmentCsv(csv,fixture.mapping,'source-offset');
  const decisions=analyzeColumns(parsed.headers,parsed.rows.map(r=>r.values),fixture.mapping,fixture.confirmedFields,fixture.locationId??null,true,!!fixture.interpretation);
  const summary=shipmentInterpretation(parsed.headers,parsed.rows.map(r=>r.values),decisions);
  if(fixture.interpretation)expect(summary).toEqual({version:CSV_RULES.interpretation.version,...fixture.interpretation});
  for(const [field,counts] of Object.entries(fixture.fieldCounts??{}))expect(decisions.find(d=>d.field===field)).toMatchObject({validRowCount:counts.valid,invalidRowCount:counts.invalid});
  const ready=(!fixture.interpretation||summary.outcome==='automatic')&&decisions.every(d=>['validated','missing_optional'].includes(d.state))&&parsed.rows.every(r=>r.status==='valid');
  expect(ready).toBe(fixture.ready);
  if(fixture.name==='screenshot-supported')expect(parsed.rows[0].normalized).toEqual({shipmentReference:'PP-TEST-20261113-001',itemTitle:'TEST ONLY - PVC elbow 1 inch',quantity:12,shippedAt:'2026-11-13T09:00:00-05:00',shipmentDate:'2026-11-13',trackingNumber:null,carrier:null,locationId:null});
  if(fixture.name==='leading-zero-long-id')expect(parsed.rows[0].normalized?.shipmentReference).toBe('0'.repeat(70));
 });
 it('keeps unknown exporter and cadence honest, with explicit v2 history and rule bindings',()=>{
  const contract={schema:'packproof.scheduled-csv/v2',exporterName:null,exporterVersion:null,expectedHeaders:['Shipment reference','Description','Quantity','Shipment date'],expectedIntervalSeconds:null,backfillFrom:'2026-11-13T00:00:00Z',rulesVersion:CSV_RULES.version,profileVersion:CSV_RULES.profile,analysisRevision:1,confirmedFields:[],historyPolicy:{mode:'selected_then_new',baselineSha256:'a'.repeat(64),observedAt:'2026-11-13T10:00:00Z',initialFileName:'synthetic.csv',initialFileSha256:'b'.repeat(64)}};
  expect(validateScheduledCsvSourceContract(contract)).toEqual(contract);
  for(const change of [{interpretationVersion:'future',basedOnConfigRevision:1},{interpretationVersion:CSV_RULES.interpretation.version,basedOnConfigRevision:-1},{interpretationVersion:CSV_RULES.interpretation.version},{rulesVersion:'old'},{expectedHeaders:['Shipment-ID','Shipment_ID']},{historyPolicy:{...contract.historyPolicy,initialFileName:'../secret.csv'}}])expect(()=>validateScheduledCsvSourceContract({...contract,...change})).toThrow();
  const approved=validateScheduledCsvSourceContract(contract), parsed=parseShipmentCsv(corpus[0].csv,undefined,'source-offset');
  expect(()=>validateScheduledCsvRows({folderDigest:'f'.repeat(64),sourceName:'Synthetic',integrationAccountId:'source',operatorMembershipId:'operator',locationId:null,mapping:parsed.mapping,timeZone:'source-offset',importValidRows:false,offlineWindowHours:24,sourceContract:approved},parsed.rows,parsed.headers)).not.toThrow();
 });
});
