import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseTypedSourceBatch,canonicalSourceObservation,sourceReferenceKey} from '../src/records/source-contracts.js';
import {SOURCE_PROFILES,TYPED_SOURCE_LIMITS} from '../src/records/source-profiles.js';
const corpus=JSON.parse(readFileSync(new URL('./fixtures/reconstruction/source-contract-corpus.json',import.meta.url),'utf8'));
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const first=()=>structuredClone(corpus.cases[0].input);
function replaceRows(input:ReturnType<typeof first>,rows:unknown[]){input.original.content=JSON.stringify(rows);input.original.sha256=digest(input.original.content);return input;}
describe('versioned typed source contracts',()=>{
 for(const fixture of corpus.cases)it(`golden original parity: ${fixture.name}`,()=>{
  const parsed=parseTypedSourceBatch(fixture.input);
  expect(parsed.rows).toHaveLength(fixture.expected.rowCount);
  expect(parsed.rows.filter(r=>r.normalized)).toHaveLength(fixture.expected.validRows);
  expect(parsed.rows.map(({rowNumber,normalized,payloadSha256,errors})=>({rowNumber,normalized,payloadSha256,errors}))).toEqual(fixture.expected.rows);
  for(const text of fixture.expected.errorContains)expect(parsed.rows.flatMap(r=>r.errors).join(' ')).toContain(text);
 });
 it('retains order-only data as order/line assertions without inventing shipment facts',()=>{
  const input=first(),row=JSON.parse(input.original.content)[0],parsed=parseTypedSourceBatch(replaceRows(input,[row]));
  expect(parsed.rows[0].normalized!.references.map(r=>r.type)).toEqual(['order','order_line']);
  expect(parsed.rows[0].normalized!.references[0].externalId).toBe('0010482');
  expect(parsed.rows[0].normalized!.assertions[0].value).toEqual({amount:'10',unit:'each'});
  expect(parsed.rows[0].normalized!.occurredAt).toBeNull();
 });
 it('new profile preserves two different lines of one shipment as separate valid rows',()=>{
  const input=first(),rows=JSON.parse(input.original.content),line=structuredClone(rows[1]);
  line.sourceEventId+='-second-line';
  for(const r of line.references)if(r.type==='order_line')r.externalId='005';
  for(const a of line.assertions)a.subjectReference.externalId='005';
  for(const r of line.relationships)if(r.to.type==='order_line')r.to.externalId='005';
  const parsed=parseTypedSourceBatch(replaceRows(input,[rows[1],line]));
  expect(parsed.rows.every(r=>r.errors.length===0)).toBe(true);
  expect(parsed.rows.map(r=>r.normalized!.references.find(x=>x.type==='order_line')!.externalId)).toEqual(['004','005']);
 });
 it('hashes the business observation independently of changing source row positions',()=>{
  const input=first(),rows=JSON.parse(input.original.content),original=parseTypedSourceBatch(input),moved=parseTypedSourceBatch(replaceRows(input,[rows[1],rows[0]]));
  expect(original.rows[0].payloadSha256).toBe(moved.rows[1].payloadSha256);
  expect(original.rows[0].normalized!.assertions[0].sourceLocator.row).toBe(1);
  expect(moved.rows[1].normalized!.assertions[0].sourceLocator.row).toBe(2);
 });
 it('derives JSON provenance from the actual original instead of trusting supplied locators',()=>{
  const input=first(),rows=JSON.parse(input.original.content);rows[0].assertions[0].sourceLocator={row:9000,field:'another customer'};
  const parsed=parseTypedSourceBatch(replaceRows(input,rows));
  expect(parsed.rows[0].normalized!.assertions[0].sourceLocator).toEqual({row:1,field:'assertions[0].value',jsonPointer:'/0/assertions/0/value'});
 });
 it('preserves explicit revisions and immutable content changes in different business fingerprints',()=>{
  const input=first(),rows=JSON.parse(input.original.content),before=parseTypedSourceBatch(input);rows[0].assertions[0].value.amount='9';
  const changed=parseTypedSourceBatch(replaceRows(input,rows));expect(before.rows[0].payloadSha256).not.toBe(changed.rows[0].payloadSha256);
  expect(changed.rows[0].normalized!.sourceEventId).toBe(before.rows[0].normalized!.sourceEventId);
 });
 it('requires the explicit parent order when line numbers are scoped to an order',()=>{
  const input=first(),rows=JSON.parse(input.original.content);delete rows[0].references.find((r:any)=>r.type==='order_line').parentExternalId;
  expect(parseTypedSourceBatch(replaceRows(input,rows)).rows[0].normalized).toBeNull();
  const a={namespace:'erp',type:'order_line' as const,externalId:'004',parentExternalId:'0010482'},b={...a,parentExternalId:'0010483'};
  expect(sourceReferenceKey(a)).not.toBe(sourceReferenceKey(b));
 });
 it('requires an explicitly co-reported parent even when an observation supplies no relationship edges',()=>{
  const input=structuredClone(corpus.cases.find((c:any)=>c.name==='loading-eight-revision-two').input),rows=JSON.parse(input.original.content);rows[0].relationships=[];
  rows[0].references=rows[0].references.filter((r:any)=>r.type!=='order');
  expect(parseTypedSourceBatch(replaceRows(input,rows)).rows[0].errors.join(' ')).toMatch(/parent/);
  rows[0].references.push({namespace:input.sourceNamespace,type:'order',externalId:'WRONG-PARENT'});
  expect(parseTypedSourceBatch(replaceRows(input,rows)).rows[0].errors.join(' ')).toMatch(/parent/);
 });
 it('does not accept a line relationship to a different co-reported parent order',()=>{
  const input=first(),rows=JSON.parse(input.original.content);const r=rows[0];
  for(const ref of [r.references[1],r.assertions[0].subjectReference,r.relationships[0].to])ref.parentExternalId='0010483';
  expect(parseTypedSourceBatch(replaceRows(input,rows)).rows[0].errors.join(' ')).toMatch(/parent/);
 });
 it('does not coerce integer identifiers or locale/exponent quantities into facts',()=>{
  const input=first(),rows=JSON.parse(input.original.content);rows[0].references[0].externalId=10482;rows[1].assertions[0].value.amount='1e1';
  const parsed=parseTypedSourceBatch(replaceRows(input,rows));expect(parsed.rows.every(r=>r.normalized===null)).toBe(true);
 });
 it('requires complete-original approval and verifies every exact UTF-8 byte',()=>{
  const noConsent=first();noConsent.wholeFileConsent=false;expect(()=>parseTypedSourceBatch(noConsent)).toThrow(/complete original/);
  const altered=first();altered.original.content+=' ';expect(()=>parseTypedSourceBatch(altered)).toThrow(/digest/);
  const invalidUnicode=first();invalidUnicode.original.content='\ud800';invalidUnicode.original.sha256=digest(invalidUnicode.original.content);expect(()=>parseTypedSourceBatch(invalidUnicode)).toThrow(/UTF-8/);
 });
 it('requires paired source subscription/revision and does not accept caller-owned normalized rows',()=>{
  const input=first();input.configurationRevision=null;expect(()=>parseTypedSourceBatch(input)).toThrow(/together/);
  expect(()=>parseTypedSourceBatch({...first(),rows:[]})).toThrow(/documented fields/);
 });
 it('does not turn a source freshness heuristic into a completeness marker',()=>{
  const input=first();input.completeness={kind:'snapshot',asOf:'2026-11-12T14:00:00-05:00',marker:null};expect(()=>parseTypedSourceBatch(input)).toThrow(/marker/);
  input.completeness={kind:'unknown',asOf:null,marker:null};expect(parseTypedSourceBatch(input).completeness.kind).toBe('unknown');
 });
 it.each(['2026-02-30T14:00:00-05:00','2026-11-12T24:00:00-05:00','2026-11-12T14:00:00','2026-11-12T14:00:00+15:00'])('retains invalid/ambiguous source time as row failure: %s',time=>{
  const input=first(),rows=JSON.parse(input.original.content);rows[0].sourceAsOf=time;const parsed=parseTypedSourceBatch(replaceRows(input,rows));expect(parsed.rows[0].normalized).toBeNull();expect(parsed.rows[1].normalized).not.toBeNull();
 });
 it('enforces the bounded inline lane rather than increasing existing ingestion limits',()=>{
  const input=first();input.original.content=' '.repeat(TYPED_SOURCE_LIMITS.bytes+1);input.original.sha256=digest(input.original.content);expect(()=>parseTypedSourceBatch(input)).toThrow(/2 MiB/);
  const rows=Array.from({length:1001},()=>JSON.parse(first().original.content)[0]);expect(()=>parseTypedSourceBatch(replaceRows(first(),rows))).toThrow(/1,000/);
 });
 it('keeps profile grains distinct and exposes only the three qualified-format candidates',()=>{
  expect(SOURCE_PROFILES.map(p=>p.id)).toEqual(['packproof.order-lines/v1','packproof.shipment-handling-units/v1','packproof.operational-observations/v1']);
  const input=first();input.sourceProfile='packproof.shipment-handling-units/v1';const parsed=parseTypedSourceBatch(input);expect(parsed.rows[0].normalized).toBeNull();expect(parsed.rows[1].normalized!.assertions[0].property).toBe('allocatedQuantity');
 });
 it('tombstones supersede a source revision without adding new assertions or relationships',()=>{
  const input=first(),row=JSON.parse(input.original.content)[0];row.sourceRevision='2';row.observationKind='tombstone';row.supersedes={sourceEventId:row.sourceEventId,sourceRevision:'1'};row.assertions=[];row.relationships=[];
  expect(parseTypedSourceBatch(replaceRows(input,[row])).rows[0].normalized?.observationKind).toBe('tombstone');
  row.relationships=[{from:row.references[0],to:row.references[1],type:'has_line',quantity:null}];
  expect(parseTypedSourceBatch(replaceRows(input,[row])).rows[0].errors.join(' ')).toMatch(/Tombstones/);
 });
 it('canonical semantic fingerprints are independent of set order and never include raw locators',()=>{
  const parsed=parseTypedSourceBatch(first()).rows[1].normalized!,copy=structuredClone(parsed);copy.references.reverse();copy.relationships.reverse();copy.assertions[0].sourceLocator.row=900;
  expect(canonicalSourceObservation(copy)).toBe(canonicalSourceObservation(parsed));
 });
});
