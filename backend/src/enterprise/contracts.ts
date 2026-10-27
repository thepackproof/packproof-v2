import { DomainError } from '../domain/errors.js';
import { record,textField } from '../platform/tenants.js';
export const STAGES=['ORDERED','AMENDED','PICKED','STAGED','LOADED','ACKNOWLEDGED','REJECTED','RETURNED','CANCELLED','DISPATCHED','DELIVERY_ATTEMPT','HANDOFF'] as const;
export type Stage=typeof STAGES[number];
export interface Mapping {
 schemaVersion:'packproof.enterprise.mapping/v1';version:string;sourceTimezone:string|null;quantitySemantics:'STAGE_SNAPSHOT';orderNamespaceSourceId:string|null;fulfillmentNamespaceSourceId:string|null;
 fields:Record<string,string>;lineFields:Record<string,string>;stageValues:Record<string,Stage>;requiredFields:string[];
 dictionary:{concept:string;sourceField:string;scope:string;nullBehavior:string;example:string}[];
}
export interface Line {orderId:string|null;lineId:string;itemId:string|null;quantity:string|null;uom:string|null;}
export interface NormalizedRecord {
 recordKey:string;revision:string;supersedesRevision:string|null;stage:Stage;fulfillmentId:string|null;customerPo:string|null;orderNamespaceSourceId:string|null;fulfillmentNamespaceSourceId:string|null;
 occurredAtLocal:string|null;sourceTimezone:string|null;occurredAtUtc:string|null;timeConfidence:'EXPLICIT_OFFSET'|'SOURCE_ZONE'|'UNKNOWN'|'AMBIGUOUS';
 lines:Line[];documentKeys:string[];handlingUnitIds:string[];candidateOrderIds:string[];warnings:string[];
}
export const canonicalMapping:Mapping={
 schemaVersion:'packproof.enterprise.mapping/v1',version:'1',sourceTimezone:null,quantitySemantics:'STAGE_SNAPSHOT',orderNamespaceSourceId:null,fulfillmentNamespaceSourceId:null,
 fields:{recordKey:'record_key',revision:'revision',supersedesRevision:'supersedes_revision',stage:'stage',orderId:'order_id',fulfillmentId:'fulfillment_id',customerPo:'customer_po',occurredAtLocal:'occurred_at_local',sourceTimezone:'source_timezone',lines:'lines',documentKeys:'document_keys',handlingUnitIds:'handling_unit_ids',candidateOrderIds:'candidate_order_ids'},
 lineFields:{orderId:'order_id',lineId:'line_id',itemId:'item_id',quantity:'quantity',uom:'uom'},
 stageValues:Object.fromEntries(STAGES.map(s=>[s,s])),requiredFields:['recordKey','revision','stage','lines'],
 dictionary:[{concept:'orderId',sourceField:'order_id',scope:'site + source + sales order',nullBehavior:'quarantine; reviewer association required',example:'SYNTH-NORMAL'},
 {concept:'quantity',sourceField:'lines.quantity',scope:'line + fulfillment + stage snapshot',nullBehavior:'Unknown, never zero',example:'8.000000'},
 {concept:'lineId',sourceField:'lines.line_id',scope:'native line ID within native sales order',nullBehavior:'quarantine',example:'2'}]
};
function bad(message:string):never{throw new DomainError('INVALID_ENTERPRISE_INPUT',message,400);}
function safePath(v:unknown){if(typeof v!=='string'||!/^[_a-zA-Z][_a-zA-Z0-9]*(\.[_a-zA-Z][_a-zA-Z0-9]*){0,5}$/.test(v)||v.split('.').some(s=>['__proto__','constructor','prototype'].includes(s)))bad('Mapping fields must be safe property paths');}
export function mappingInput(input:unknown):Mapping{
 const b=record(input);if(b.schemaVersion!=='packproof.enterprise.mapping/v1'||b.quantitySemantics!=='STAGE_SNAPSHOT')bad('A versioned stage-snapshot mapping is required');
 const fields=record(b.fields),lineFields=record(b.lineFields),values=record(b.stageValues);
 for(const [k,v] of Object.entries(fields)){if(!Object.hasOwn(canonicalMapping.fields,k))bad('Unknown canonical field');safePath(v);}
 for(const [k,v] of Object.entries(lineFields)){if(!Object.hasOwn(canonicalMapping.lineFields,k))bad('Unknown canonical line field');safePath(v);}
 for(const k of ['recordKey','revision','stage','lines'])if(!fields[k])bad('Mapping is missing '+k);
 if(!lineFields.lineId)bad('Mapping requires a native line ID');
 if(!Object.keys(values).length||Object.values(values).some(v=>!STAGES.includes(v as Stage)))bad('Invalid stage mapping');
 if(!Array.isArray(b.requiredFields)||b.requiredFields.some(v=>!Object.hasOwn(canonicalMapping.fields,String(v))))bad('Invalid required fields');
 if(!Array.isArray(b.dictionary)||!b.dictionary.length||b.dictionary.length>100)bad('A semantic mapping dictionary is required');
 const dictionary=b.dictionary.map(v=>{const r=record(v);return {concept:textField(r.concept,'concept'),sourceField:textField(r.sourceField,'sourceField'),scope:textField(r.scope,'scope'),nullBehavior:textField(r.nullBehavior,'nullBehavior'),example:textField(r.example,'example')};});
 const zone=b.sourceTimezone==null?null:textField(b.sourceTimezone,'sourceTimezone',80);if(zone)validateZone(zone);
 return {schemaVersion:'packproof.enterprise.mapping/v1',version:textField(b.version,'version',40),sourceTimezone:zone,quantitySemantics:'STAGE_SNAPSHOT',orderNamespaceSourceId:b.orderNamespaceSourceId==null?null:textField(b.orderNamespaceSourceId,'orderNamespaceSourceId'),fulfillmentNamespaceSourceId:b.fulfillmentNamespaceSourceId==null?null:textField(b.fulfillmentNamespaceSourceId,'fulfillmentNamespaceSourceId'),fields:fields as Record<string,string>,lineFields:lineFields as Record<string,string>,stageValues:values as Record<string,Stage>,requiredFields:b.requiredFields as string[],dictionary};
}
function get(row:Record<string,unknown>,p:string|undefined):unknown{if(!p)return undefined;let v:unknown=row;for(const k of p.split('.')){if(!v||typeof v!=='object'||!Object.hasOwn(v,k))return undefined;v=(v as Record<string,unknown>)[k];}return v;}
function optional(v:unknown,name:string,max=200):string|null{return v===undefined||v===null||v===''?null:textField(v,name,max);}
function list(v:unknown,name:string):string[]{if(v===undefined||v===null||v==='')return [];if(typeof v==='string'){try{v=JSON.parse(v);}catch{bad(name+' must be a JSON array');}}if(!Array.isArray(v)||v.length>100)bad(name+' must have at most 100 items');return [...new Set(v.map(x=>textField(x,name,200)))];}
export function decimal(v:unknown):string|null{if(v===undefined||v===null||v==='')return null;if(typeof v!=='string'||!/^\d{1,18}(\.\d{1,6})?$/.test(v))bad('Quantities must be nonnegative decimal strings with at most six decimal places');return v.replace(/^0+(?=\d)/,'');}
export function units(v:string):bigint{const [a,b='']=v.split('.');return BigInt(a)*1000000n+BigInt(b.padEnd(6,'0'));}
export function decimalString(v:bigint):string{const negative=v<0n,n=negative?-v:v,tail=(n%1000000n).toString().padStart(6,'0').replace(/0+$/,'');return (negative?'-':'')+(n/1000000n).toString()+(tail?'.'+tail:'');}
function validateZone(z:string){try{new Intl.DateTimeFormat('en-US',{timeZone:z}).format();}catch{bad('Unknown IANA source timezone');}}
export function sourceTime(local:string|null,zone:string|null):Pick<NormalizedRecord,'occurredAtUtc'|'timeConfidence'>{
 if(!local)return {occurredAtUtc:null,timeConfidence:'UNKNOWN'};
 const m=/^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?(Z|[+-]\d\d:\d\d)?$/.exec(local);
 if(!m)bad('Source timestamp must be an ISO local time or include an explicit offset');
 const naive=Date.parse(m[1]+'T'+m[2]+'.'+(m[3]??'0').padEnd(3,'0')+'Z');
 if(!Number.isFinite(naive)||new Date(naive).toISOString().slice(0,19)!==local.slice(0,19))bad('Invalid source calendar timestamp');
 if(m[4]){const utc=Date.parse(local);if(!Number.isFinite(utc))bad('Invalid timestamp offset');return {occurredAtUtc:new Date(utc).toISOString(),timeConfidence:'EXPLICIT_OFFSET'};}
 if(!zone)return {occurredAtUtc:null,timeConfidence:'UNKNOWN'};validateZone(zone);
 const fmt=new Intl.DateTimeFormat('sv-SE',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 const target=local.slice(0,19).replace('T',' '),candidates:number[]=[];
 for(let offset=-14*60;offset<=14*60;offset+=15){const candidate=naive+offset*60000;if(fmt.format(candidate)===target)candidates.push(candidate);}
 return candidates.length===1?{occurredAtUtc:new Date(candidates[0]).toISOString(),timeConfidence:'SOURCE_ZONE'}:{occurredAtUtc:null,timeConfidence:'AMBIGUOUS'};
}
export function normalize(input:unknown,map:Mapping):NormalizedRecord{
 const row=record(input),read=(k:string)=>get(row,map.fields[k]);
 for(const k of map.requiredFields){const v=read(k);if(v==null||v==='')bad('Missing mapped field: '+k);}
 const stage=Object.hasOwn(map.stageValues,String(read('stage')))?map.stageValues[String(read('stage'))]:undefined;if(!stage)bad('Unmapped source stage');
 let lines=read('lines');if(typeof lines==='string'){try{lines=JSON.parse(lines);}catch{bad('Lines must be a JSON array');}}
 if(!Array.isArray(lines)||!lines.length||lines.length>100)bad('Supply 1-100 source line assertions');
 const order=optional(read('orderId'),'orderId'),seen=new Set<string>();
 const parsed=lines.map(value=>{const l=record(value),r=(k:string)=>get(l,map.lineFields[k]),orderId=optional(r('orderId'),'line.orderId')??order;
  const lineId=textField(r('lineId'),'lineId',100),identity=JSON.stringify([orderId,lineId]);if(seen.has(identity))bad('Duplicate line within source record');seen.add(identity);
  const quantity=decimal(r('quantity')),uom=optional(r('uom'),'uom',30);if(quantity!==null&&!uom)bad('Every quantity requires a UOM');
  return {orderId,lineId,quantity,uom,itemId:optional(r('itemId'),'itemId')};});
 const occurredAtLocal=optional(read('occurredAtLocal'),'occurredAtLocal',80),sourceTimezone=optional(read('sourceTimezone'),'sourceTimezone',80)??map.sourceTimezone,time=sourceTime(occurredAtLocal,sourceTimezone);
 return {recordKey:textField(read('recordKey'),'recordKey'),revision:textField(read('revision'),'revision',80),supersedesRevision:optional(read('supersedesRevision'),'supersedesRevision',80),stage,fulfillmentId:optional(read('fulfillmentId'),'fulfillmentId'),customerPo:optional(read('customerPo'),'customerPo'),orderNamespaceSourceId:map.orderNamespaceSourceId??null,fulfillmentNamespaceSourceId:map.fulfillmentNamespaceSourceId??null,
 occurredAtLocal,sourceTimezone,...time,lines:parsed,documentKeys:list(read('documentKeys'),'documentKeys'),handlingUnitIds:list(read('handlingUnitIds'),'handlingUnitIds'),candidateOrderIds:list(read('candidateOrderIds'),'candidateOrderIds'),
 warnings:[...(time.timeConfidence==='UNKNOWN'?['SOURCE_TIMESTAMP_MISSING_OR_ZONE_UNKNOWN']:[]),...(time.timeConfidence==='AMBIGUOUS'?['SOURCE_TIMESTAMP_AMBIGUOUS']:[])]};
}
export function parseCsv(text:string):Record<string,string>[]{
 const rows:string[][]=[];let row:string[]=[],field='',quoted=false,closed=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;continue;}
  if(c==='"'){if(field||closed)bad('Malformed CSV quote');quoted=true;continue;}
  if(c===','||c==='\n'||c==='\r'){row.push(field);field='';closed=false;if(c!==','){if(c==='\r'&&text[i+1]==='\n')i++;rows.push(row);row=[];}continue;}
  if(closed)bad('Unexpected character after CSV quote');field+=c;
 }
 if(quoted)bad('Unclosed CSV quote');if(field||closed||row.length)rows.push([...row,field]);
 if(!rows.length)bad('CSV has no header');const headers=rows.shift()!;headers[0]=headers[0].replace(/^\uFEFF/,'');
 if(headers.some(h=>!h||['__proto__','constructor','prototype'].includes(h))||new Set(headers).size!==headers.length)bad('CSV headers must be unique safe names');
 if(rows.length>500)bad('A pilot batch accepts at most 500 records');
 return rows.map(values=>{if(values.length!==headers.length)bad('CSV column count differs from header');return Object.fromEntries(headers.map((h,i)=>[h,values[i]]));});
}
