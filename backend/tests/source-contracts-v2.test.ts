import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseTypedSourceBatch} from '../src/records/source-contracts.js';
import {parseSourceIdentityPolicy,compositeSourceEventId} from '../src/records/source-identity-policy.js';
const corpus=JSON.parse(readFileSync(new URL('./fixtures/reconstruction/source-contract-corpus-v2.json',import.meta.url),'utf8'));
const fixture=(name:string)=>structuredClone(corpus.cases.find((f:any)=>f.name===name).input);
const parsed=(name:string)=>parseTypedSourceBatch(fixture(name)).rows[0];
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
function content(input:any,value:string){input.original.content=value;input.original.sha256=digest(value);return input;}
describe('explicitly approved v2 source identities',()=>{
 for(const f of corpus.cases)it(`shared golden original: ${f.name}`,()=>{
  const p=parseTypedSourceBatch(f.input);
  expect(p.rows.filter(r=>r.normalized)).toHaveLength(f.expected.validRows);
  expect(p.rows.map(({rowNumber,normalized,payloadSha256,errors})=>({rowNumber,normalized,payloadSha256,errors}))).toEqual(f.expected.rows);
 });
 it('derives exact leading-zero-safe row grain without source IDs, versions or content hashes',()=>{
  const p=parsed('composite-order-no-dedicated-ids').normalized!;
  expect(p.sourceEventId).toBe('composite:v1:7:orderId7:001048211:orderLineId3:0048:property15:orderedQuantity');
  expect(p.sourceRevision).toBe('snapshot:2026-11-12T19:00:00.000Z');
  expect(p.identityDerivation!.eventKey.components).toEqual([
   {field:'orderId',value:'0010482',sourceLocator:{row:2,field:'Order'},approvedConstant:false},
   {field:'orderLineId',value:'004',sourceLocator:{row:2,field:'Line'},approvedConstant:false},
   {field:'property',value:'orderedQuantity',sourceLocator:null,approvedConstant:true},
  ]);
  expect(p.identityDerivation!.revision).toEqual({kind:'source_as_of',sourceValue:'2026-11-12T14:00:00-05:00',sourceLocator:{row:2,field:'AsOf'}});
  expect(p.occurredAt).toBeNull();expect(p.supersedes).toBeNull();
 });
 it('keeps business fingerprints stable across row movement and equivalent timestamp offsets',()=>{
  const original=parsed('composite-order-no-dedicated-ids'),moved=parseTypedSourceBatch(fixture('composite-order-reordered')).rows[1],offset=parsed('composite-order-offset-alias');
  expect(moved.payloadSha256).toBe(original.payloadSha256);expect(offset.payloadSha256).toBe(original.payloadSha256);
  expect(moved.normalized!.identityDerivation!.eventKey.components[0].sourceLocator!.row).toBe(3);
  expect(offset.normalized!.sourceAsOf).toBe('2026-11-12T19:00:00Z');
 });
 it('distinguishes next snapshot from changed content under the same instant',()=>{
  const original=parsed('composite-order-no-dedicated-ids'),next=parsed('composite-order-next-snapshot'),conflict=parsed('composite-order-same-boundary-content-conflict');
  expect(next.normalized!.sourceEventId).toBe(original.normalized!.sourceEventId);
  expect(next.normalized!.sourceRevision).not.toBe(original.normalized!.sourceRevision);
  expect(conflict.normalized!.sourceRevision).toBe(original.normalized!.sourceRevision);
  expect(conflict.payloadSha256).not.toBe(original.payloadSha256);
 });
 it('does not collapse delimiters, Unicode, line parents or leading zeros',()=>{
  const rows=parseTypedSourceBatch(fixture('composite-delimiter-and-unicode-parts')).rows;
  expect(rows[0].normalized!.sourceEventId).toContain('5:00:α');
  expect(rows[0].normalized!.sourceEventId).not.toBe(rows[1].normalized!.sourceEventId);
  const get=(order:string,line:string)=>(field:string)=>field==='orderId'?order:line;
  expect(compositeSourceEventId(['orderId','orderLineId'],get('001','04'))).not.toBe(compositeSourceEventId(['orderId','orderLineId'],get('01','004')));
 });
 it('retains immutable-event revision as a contract tag with source revision unknown',()=>{
  const original=parsed('composite-label-immutable-event'),conflict=parsed('composite-label-same-event-content-conflict');
  expect(original.normalized!.sourceRevision).toBe('immutable-event/v1');
  expect(original.normalized!.identityDerivation!.revision).toEqual({kind:'immutable_event',sourceValue:null,sourceLocator:null});
  expect(original.normalized!.assertions[0].subjectReference.type).toBe('tracking');
  expect(conflict.normalized!.sourceEventId).toBe(original.normalized!.sourceEventId);expect(conflict.normalized!.sourceRevision).toBe(original.normalized!.sourceRevision);expect(conflict.payloadSha256).not.toBe(original.payloadSha256);
 });
 it('requires actual key components and explicit superseded boundaries',()=>{
  expect(parsed('composite-order-missing-component').normalized).toBeNull();
  expect(parsed('composite-order-explicit-correction').normalized!.supersedes!.sourceRevision).toBe('snapshot:2026-11-13T19:00:00.000Z');
  const f=fixture('composite-order-explicit-correction');delete f.mapping.supersedesRevision;
  expect(parseTypedSourceBatch(f).rows[0].errors.join(' ')).toMatch(/superseded/);
 });
 it.each(['amount','value','occurredAt','sourceAsOf','fileSha256','originalSha256'])('rejects content, quantity or timestamp as identity: %s',field=>{
  expect(()=>parseSourceIdentityPolicy({schema:'packproof.source-identity-policy/v1',eventKey:{kind:'composite',fields:['orderId',field]},revision:{kind:'source_as_of'}})).toThrow(/identity components/);
 });
 it('requires complete declared row grain and actual event sequence',()=>{
  const f=fixture('composite-order-no-dedicated-ids');f.identityPolicy.eventKey.fields=['orderId','property'];expect(()=>parseTypedSourceBatch(f)).toThrow(/orderLineId/);
  const event=fixture('composite-label-immutable-event');event.identityPolicy.eventKey.fields=['shipmentId','trackingId','property'];expect(()=>parseTypedSourceBatch(event)).toThrow(/actual event/);
  event.identityPolicy.eventKey.fields.push('sourceSequence');event.identityPolicy.revision.kind='source_as_of';event.mapping.sourceAsOf='At';delete event.mapping.occurredAt;expect(()=>parseTypedSourceBatch(event)).toThrow(/event/);
 });
 it('requires explicit v2 approval and leaves v1 vocabulary strict',()=>{
  const f=fixture('composite-order-no-dedicated-ids');delete f.identityPolicy;expect(()=>parseTypedSourceBatch(f)).toThrow();
  f.schema='packproof.typed-source-batch/v1';expect(()=>parseTypedSourceBatch({...f,identityPolicy:{}})).toThrow(/documented fields/);
  const old=JSON.parse(readFileSync(new URL('./fixtures/reconstruction/source-contract-corpus.json',import.meta.url),'utf8')).cases.find((c:any)=>c.input.original.mediaType==='application/json').input;
  const rows=JSON.parse(old.original.content);rows[0].assertions[0].property='labelStatus';expect(parseTypedSourceBatch(content(old,JSON.stringify(rows))).rows[0].normalized).toBeNull();
 });
 it('does not accept caller-claimed identity derivation on JSON observations',()=>{
  const f=fixture('composite-label-immutable-event'),row=parsed('composite-label-immutable-event').normalized!;
  f.identityPolicy={schema:'packproof.source-identity-policy/v1',eventKey:{kind:'column'},revision:{kind:'column'}};f.mapping={};f.constants={};f.original.mediaType='application/json';
  expect(parseTypedSourceBatch(content(f,JSON.stringify([row]))).rows[0].errors.join(' ')).toMatch(/documented fields/);
  delete row.identityDerivation;const p=parseTypedSourceBatch(content(f,JSON.stringify([row]))).rows[0].normalized!;
  expect(p.identityDerivation!.revision.kind).toBe('column');expect(p.identityDerivation!.eventKey.components[0].sourceLocator!.jsonPointer).toBe('/0/sourceEventId');
 });
 it('does not convert an aggregate load or a planned handoff deadline to physical unit evidence',()=>{
  const f=fixture('composite-handoff-explicit-deadline'),p=parseTypedSourceBatch(f).rows[0].normalized!;
  expect(p.occurredAt).toBeNull();expect(p.assertions[0].property).toBe('expectedHandoffAt');expect(p.assertions[0].subjectReference.type).toBe('handling_unit');
  expect(parsed('composite-handoff-missing-stop').normalized).toBeNull();
  f.identityPolicy={schema:'packproof.source-identity-policy/v1',eventKey:{kind:'column'},revision:{kind:'column'}};f.mapping={};f.constants={};f.original.mediaType='application/json';delete p.identityDerivation;
  p.relationships=p.relationships.filter(r=>r.type!=='contains');expect(parseTypedSourceBatch(content(f,JSON.stringify([p]))).rows[0].errors.join(' ')).toMatch(/membership/);
 });
 it('rejects oversized UTF-8 v2 namespace, site and revision values without truncating source strings',()=>{
  for(const field of ['sourceNamespace','locationId']){const f=fixture('composite-order-no-dedicated-ids');f[field]='€'.repeat(75);expect(()=>parseTypedSourceBatch(f)).toThrow(/200 UTF-8/);}
  expect(parsed('composite-source-revision-utf8-overflow').errors.join(' ')).toMatch(/200 UTF-8/);
 });
 it('bounds UTF-8 composite keys before they reach indexed business identity storage',()=>{
  expect(()=>compositeSourceEventId(['orderId','orderLineId','shipmentId','property'],()=> 'α'.repeat(200))).toThrow(/1,024 UTF-8/);
 });
});
