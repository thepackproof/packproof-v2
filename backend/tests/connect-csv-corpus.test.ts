import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { analyzeColumns, CSV_RULES } from '../src/records/csv-semantics.js';
import { parseShipmentCsv } from '../src/records/csv.js';
import { validateScheduledCsvRows, validateScheduledCsvSourceContract } from '../src/records/agent-restrictions.js';
const corpus=JSON.parse(readFileSync(new URL('./fixtures/connect-csv-corpus.json',import.meta.url),'utf8')) as Array<{name:string;csv:string;ready:boolean;mapping?:Record<string,string>;confirmedFields?:string[];locationId?:string;parseError?:boolean}>;
describe('shared raw CSV semantic corpus (also run by the C# service)',()=>{
 for(const fixture of corpus)it(fixture.name,()=>{
  if(fixture.parseError){expect(()=>parseShipmentCsv(fixture.csv,fixture.mapping,'source-offset')).toThrow();return;}
  const parsed=parseShipmentCsv(fixture.csv,fixture.mapping,'source-offset');
  const decisions=analyzeColumns(parsed.headers,parsed.rows.map(r=>r.values),fixture.mapping,fixture.confirmedFields,fixture.locationId??null);
  const ready=decisions.every(d=>['validated','missing_optional'].includes(d.state))&&parsed.rows.every(r=>r.status==='valid');
  expect(ready).toBe(fixture.ready);
  if(fixture.name==='screenshot-supported')expect(parsed.rows[0].normalized).toEqual({shipmentReference:'PP-TEST-20261113-001',itemTitle:'TEST ONLY - PVC elbow 1 inch',quantity:12,shippedAt:'2026-11-13T09:00:00-05:00',shipmentDate:'2026-11-13',trackingNumber:null,carrier:null,locationId:null});
  if(fixture.name==='leading-zero-long-id')expect(parsed.rows[0].normalized?.shipmentReference).toBe('0'.repeat(70));
 });
 it('keeps unknown exporter and cadence honest, with explicit v2 history and rule bindings',()=>{
  const contract={schema:'packproof.scheduled-csv/v2',exporterName:null,exporterVersion:null,expectedHeaders:['Shipment reference','Description','Quantity','Shipment date'],expectedIntervalSeconds:null,backfillFrom:'2026-11-13T00:00:00Z',rulesVersion:CSV_RULES.version,profileVersion:CSV_RULES.profile,analysisRevision:1,confirmedFields:[],historyPolicy:{mode:'selected_then_new',baselineSha256:'a'.repeat(64),observedAt:'2026-11-13T10:00:00Z',initialFileName:'synthetic.csv',initialFileSha256:'b'.repeat(64)}};
  expect(validateScheduledCsvSourceContract(contract)).toEqual(contract);
  for(const change of [{rulesVersion:'old'},{expectedHeaders:['Shipment-ID','Shipment_ID']},{historyPolicy:{...contract.historyPolicy,initialFileName:'../secret.csv'}}])expect(()=>validateScheduledCsvSourceContract({...contract,...change})).toThrow();
  const approved=validateScheduledCsvSourceContract(contract), parsed=parseShipmentCsv(corpus[0].csv,undefined,'source-offset');
  expect(()=>validateScheduledCsvRows({folderDigest:'f'.repeat(64),sourceName:'Synthetic',integrationAccountId:'source',operatorMembershipId:'operator',locationId:null,mapping:parsed.mapping,timeZone:'source-offset',importValidRows:false,offlineWindowHours:24,sourceContract:approved},parsed.rows,parsed.headers)).not.toThrow();
 });
});
