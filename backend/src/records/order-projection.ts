import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {DomainError} from '../domain/errors.js';
import {strictBody} from '../platform/organizations.js';
import {boundedText} from './order-workspace.js';

const kinds=['order','picking','packing','evidence','label','handoff','delivery','return','correction'];
const entityTypes=['order','order_line','warehouse_order','shipment','package','tracking','event','artifact','return','load','pallet','label','delivery','handoff','pick','packing','warehouse','document','photo','task'];
const quantityFields=['orderedQuantity','pickedQuantity','packedQuantity','shippedQuantity','returnedQuantity','cancelledQuantity'] as const;
function reference(v:unknown){
 const b=strictBody(v,['namespace','type','id']);
 if(!entityTypes.includes(String(b.type)))throw new DomainError('PROFILE_AMBIGUOUS','Choose a supported entity type for this source.',422);
 return {namespace:boundedText(b.namespace,'reference namespace'),type:String(b.type),id:boundedText(b.id,'external identity')};
}
type Ref=ReturnType<typeof reference>;
type Scalar=string|null|boolean;
type Line=Record<string,string|null>&{lineId:string};
export const refKey=(ref:Ref)=>sha256Hex(canonicalize([ref.namespace,ref.type,ref.id]));
function parseLine(v:unknown):Line{
 const b=strictBody(v,['lineId','sku','unit',...quantityFields]);
 const line:Line={lineId:boundedText(b.lineId,'order line')};
 for(const [key,val] of Object.entries(b)){
  if(key==='lineId')continue;
  if(val===null||val===''){line[key]=val;continue;}
  const value=boundedText(val,key);
  if(quantityFields.some(q=>q===key)&&!/^\d{1,18}(?:\.\d{1,9})?$/.test(value))throw new DomainError('PROFILE_AMBIGUOUS','Quantities require a nonnegative decimal string.',422);
  line[key]=value;
 }
 return line;
}
export function parseRecord(input:unknown){
 const b=strictBody(input,['eventId','version','kind','entity','references','fields','lines','occurredAt','locator','sourceModifiedAt','fieldLineage']);
 const kind=b.kind==='returns'?'return':String(b.kind);
 if(!kinds.includes(kind)||!Array.isArray(b.references)||b.references.length>32||b.lines!=null&&(!Array.isArray(b.lines)||b.lines.length>256))throw new DomainError('PROFILE_AMBIGUOUS','The source record has unsupported relationships or line allocations.',422);
 const entity=reference(b.entity),references=b.references.map(reference);
 if(kind==='order'&&entity.type!=='order')throw new DomainError('PROFILE_AMBIGUOUS','An order origin needs a scoped order identity.',422);
 const raw=b.fields;
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length>96)throw new DomainError('PROFILE_AMBIGUOUS','A bounded set of source fields is required.',422);
 const fields:Record<string,Scalar>=Object.create(null);
 for(const [k,v] of Object.entries(raw)){
  if(!k||k.length>180||['__proto__','prototype','constructor'].includes(k)||!(v===null||typeof v==='boolean'||typeof v==='string'&&v.length<=4096))throw new DomainError('PROFILE_AMBIGUOUS','Preserve exact field values as bounded source strings.',422);
  fields[k]=v;
 }
 const timestamp=(v:unknown)=>{if(v==null||v==='')return null;const s=boundedText(v,'timestamp',64);if(!/(?:Z|[+-]\d\d:\d\d)$/i.test(s)||!Number.isFinite(Date.parse(s)))throw new DomainError('PROFILE_AMBIGUOUS','A reported timestamp needs a validated offset.',422);return s;};
 const locators:Record<string,string>=Object.create(null);
 if(b.fieldLineage!=null){if(typeof b.fieldLineage!=='object'||Array.isArray(b.fieldLineage)||Object.keys(b.fieldLineage).length>160)throw new DomainError('PROFILE_AMBIGUOUS','Provide bounded field lineage.',422);for(const [k,v] of Object.entries(b.fieldLineage)){if(['__proto__','constructor','prototype'].includes(k))throw new DomainError('PROFILE_AMBIGUOUS','Invalid source field.',422);locators[boundedText(k,'field',180)]=boundedText(v,'field locator',1600);}}
 return {fieldLineage:locators,eventId:boundedText(b.eventId,'event identity'),version:boundedText(b.version,'event version'),kind,entity,references,fields,lines:(b.lines??[]) as unknown[],occurredAt:timestamp(b.occurredAt),sourceModifiedAt:timestamp(b.sourceModifiedAt),locator:boundedText(b.locator,'field lineage',1600)};
}
export function normalizedRecord(input:unknown){
 const record=parseRecord(input);
 return {...record,lines:record.lines.map(parseLine)};
}
export type OrderRecord=ReturnType<typeof normalizedRecord>;
export interface StoredEvent {id:string;source_id:string;record:OrderRecord;receipt_id:string;original_sha256:string;file_name:string;profile_version:string;received_at:string|Date;override?:string|null;}
export interface Root {proof_id:string;source_id:string;root_key:string;order_reference:string;}
type Merged=StoredEvent&{history:StoredEvent[]};

function latest(events:StoredEvent[]){
 const groups=new Map<string,StoredEvent[]>();
 for(const e of events){const key=canonicalize([e.source_id,e.record.eventId]);const group=groups.get(key)??[];group.push(e);groups.set(key,group);}
 const merged:Merged[]=[];
 for(const group of groups.values()){
  if(group.length>1&&!group.every(e=>/^\d{1,30}$/.test(e.record.version))){
   // Incomparable versions stay reviewable with separate retained receipts.
   for(const e of group)merged.push({...e,history:[e]});
   continue;
  }
  group.sort((a,b)=>BigInt(a.record.version||'0')<BigInt(b.record.version||'0')?-1:1);
  const newest=group[group.length-1],lines=new Map<string,Line>(),fields:OrderRecord['fields']=Object.create(null);
  for(const e of group){Object.assign(fields,e.record.fields);for(const line of e.record.lines)lines.set(line.lineId,{...lines.get(line.lineId),...line});}
  merged.push({...newest,history:group,record:{...newest.record,fields,lines:[...lines.values()]}});
 }
 return merged.sort((a,b)=>a.id.localeCompare(b.id));
}
function add(map:Map<string,Set<string>>,key:string,value:string){const values=map.get(key)??new Set<string>();values.add(value);map.set(key,values);}
function lineage(e:StoredEvent){return {eventKey:e.id,receiptId:e.receipt_id,eventId:e.record.eventId,version:e.record.version,sourceId:e.source_id,originalSha256:e.original_sha256,fileName:e.file_name,profileVersion:e.profile_version,locator:e.record.locator,observedAt:new Date(e.received_at).toISOString()};}
function decimalSum(values:string[]){
 const places=Math.max(0,...values.map(v=>v.split('.')[1]?.length??0));
 const amount=values.reduce((sum,v)=>{const [a,b='']=v.split('.');return sum+BigInt(a+b.padEnd(places,'0'));},0n);
 if(!places)return String(amount);
 const digits=String(amount).padStart(places+1,'0');
 return (digits.slice(0,-places)+'.'+digits.slice(-places)).replace(/0+$/,'').replace(/\.$/,'');
}
/** Expand only explicitly identified business relationships. An order is a terminal,
 * so a consolidated shipment cannot turn one sales order into another. */
export function projectOrders(events:StoredEvent[],roots:Root[]){
 const current=latest(events),anchors=new Map(roots.map(r=>[r.root_key,r.proof_id])),explicit=new Map<string,Set<string>>(),parents=new Map<string,Set<string>>();
 for(const e of current){
  const entity=refKey(e.record.entity);
  if(e.override!==undefined){if(e.override)add(explicit,entity,e.override);continue;}
  const children=[e.record.entity,...e.record.references.filter(r=>r.type!=='order')];
  const direct=e.record.references.filter(r=>r.type==='order').map(refKey);
  if(e.record.kind==='order'&&e.record.entity.type==='order'&&roots.some(r=>r.root_key===entity&&r.source_id===e.source_id))direct.push(entity);
  for(const order of direct)if(anchors.has(order))add(explicit,entity,anchors.get(order)!);
  for(const p of e.record.references.filter(r=>r.type!=='order')){
   const key=refKey(p);if(e.record.entity.type!=='order')add(parents,entity,key);
   // A label/packing bridge explicitly binds its tracking or contained package.
   if(['label','packing','picking'].includes(e.record.kind)&&['tracking','package','shipment','warehouse_order'].includes(p.type))add(parents,key,entity);
  }
  // Explicit relationships from the order-origin identify its children as well.
  if(e.record.kind==='order'&&anchors.has(entity))for(const c of children.filter(r=>r.type!=='order'))add(explicit,refKey(c),anchors.get(entity)!);
 }
 function resolve(start:string){
  const seen=new Set<string>(),result=new Set<string>(),queue=[start];
  for(let at=0;at<queue.length;at++){
   const key=queue[at];if(seen.has(key))continue;seen.add(key);
   const found=explicit.get(key);if(found?.size){for(const id of found)result.add(id);continue;}
   for(const next of parents.get(key)??[])if(!seen.has(next))queue.push(next);
  }
  return result;
 }
 const views=new Map<string,Merged[]>(),members=new Map<string,string[]>();
 for(const e of current){
  const entity=refKey(e.record.entity),direct=e.record.references.filter(r=>r.type==='order');
  const matches=e.override!==undefined?new Set(e.override?[e.override]:[]):direct.length?new Set(direct.map(r=>anchors.get(refKey(r))).filter((id):id is string=>!!id)):
   e.record.entity.type==='order'?new Set(anchors.has(entity)&&roots.find(r=>r.root_key===entity)?.source_id===e.source_id?[anchors.get(entity)!]:[]):resolve(entity);
  for(const id of matches){const a=views.get(id)??[];a.push(e);views.set(id,a);}
  for(const original of e.history)members.set(original.id,[...matches]);
 }
 const projections=roots.map(root=>{
  const used=views.get(root.proof_id)??[],events=used.map(e=>({...e.record,...lineage(e),associationScope:(members.get(e.id)??[]).length>1?'shared':'order',lines:(members.get(e.id)??[]).length>1?[]:e.record.lines}));
  const claims=new Map<string,Map<string,Map<string,Set<string|null>>>>(),conflicts:string[]=[];
  for(const e of used){
   if((members.get(e.id)??[]).length>1)continue;
   for(const l of e.record.lines){
    const values=claims.get(l.lineId)??new Map();claims.set(l.lineId,values);
    for(const [key,value] of Object.entries(l)){
     if(key==='lineId')continue;
     const allocations=values.get(key)??new Map();values.set(key,allocations);
     // Count a package/line allocation once even if several independent sources report it.
     const partition=key.endsWith('Quantity')&&key!=='orderedQuantity'?refKey(e.record.entity):'line';
     const set=allocations.get(partition)??new Set();set.add(value);allocations.set(partition,set);
    }
   }
  }
  const lines:Line[]=[];
  for(const [lineId,values] of claims){
   const line:Line={lineId};
   for(const [key,partitions] of values){
    const entries=[...partitions.values()];
    if(entries.some(s=>s.size!==1)){conflicts.push(`${lineId}: ${key}`);continue;}
    const v=entries.map(s=>[...s][0]);
    if(v.length===1)line[key]=v[0];
    else if(v.every((x):x is string=>typeof x==='string'&&/^\d+(?:\.\d+)?$/.test(x)))line[key]=decimalSum(v);
    else if(new Set(v).size===1)line[key]=v[0];else conflicts.push(`${lineId}: ${key}`);
   }
   lines.push(line);
  }
  const evidence=used.flatMap(e=>e.history.map(v=>({...lineage(v),kind:'derived_excerpt',entity:v.record.entity,originalStatus:'retained',fields:v.record.fields}))).sort((a,b)=>a.receiptId.localeCompare(b.receiptId)||a.locator.localeCompare(b.locator));
  return {proofId:root.proof_id,orderReference:root.order_reference,lines:lines.sort((a,b)=>a.lineId.localeCompare(b.lineId)),events:events.sort((a,b)=>(a.occurredAt??a.observedAt).localeCompare(b.occurredAt??b.observedAt)||a.eventId.localeCompare(b.eventId)),evidence,conflicts:conflicts.sort()};
 });
 return {projections,members};
}
