import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import type { ObjectStore } from '../s3/object-store.js';
import { DomainError } from '../domain/errors.js';
import { newId } from '../ids.js';
import { sha256Hex } from '../hash.js';
import { canonicalize } from '../canonical.js';
import { record,textField } from '../platform/tenants.js';
import { strictBody } from '../platform/organizations.js';
import { parseStrictJson } from '../../../packages/evidence-contracts/contracts.mjs';
import { normalize,parseCsv,type Mapping,type NormalizedRecord } from './contracts.js';
import { requireSource,requireSite,audit,absent,type EnterpriseActor } from './access.js';
type AssetInput={documentKey:string;contentType:string;bytes:Buffer;sha256:string};
type Candidate={raw:unknown;sha256:string;normalized:NormalizedRecord|null;recordKey:string;revision:string;errors:string[];existingId:string|null};
export interface PreparedImport {sourceId:string;siteId:string;mappingId:string;mapping:Mapping;synthetic:boolean;format:string;bytes:Buffer;files:AssetInput[];records:Candidate[];previewDigest:string;warnings:string[];}
function invalid(message:string):never{throw new DomainError('INVALID_ENTERPRISE_IMPORT',message,400);}
function decode(v:unknown):Buffer{
 if(typeof v!=='string'||!v.length||v.length>1400000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v))invalid('Supply canonical base64 original bytes, up to 1 MiB');
 const b=Buffer.from(v,'base64');if(!b.length||b.length>1048576||b.toString('base64')!==v)invalid('Original must contain 1 byte to 1 MiB');return b;
}
function document(input:unknown):AssetInput{
 const b=strictBody(input,['documentKey','contentType','base64']),bytes=decode(b.base64),contentType=textField(b.contentType,'contentType',80);
 if(!['application/pdf','image/png','image/jpeg'].includes(contentType))invalid('Evidence accepts PDF, PNG and JPEG originals');
 const valid=contentType==='application/pdf'?bytes.subarray(0,5).toString()==='%PDF-':contentType==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 if(!valid)invalid('Original bytes do not match declared media type');
 return {documentKey:textField(b.documentKey,'documentKey'),contentType,bytes,sha256:sha256Hex(bytes)};
}
export async function prepareImport(db:Database,clock:Clock,a:EnterpriseActor,input:unknown):Promise<PreparedImport>{
 const b=strictBody(input,['schemaVersion','sourceId','mappingVersion','format','contentBase64','synthetic','files','previewDigest']);
 if(b.schemaVersion!=='packproof.enterprise.import/v1')invalid('Import schemaVersion is required');
 const sourceId=textField(b.sourceId,'sourceId'),source=await requireSource(db,clock,a,sourceId);
 if(typeof b.synthetic!=='boolean'||(source.site.mode==='SYNTHETIC')!==b.synthetic)invalid('The synthetic label must match the authorized site mode');
 const mapping=(await db.query<{id:string;dictionary:Mapping}>('SELECT id,dictionary FROM enterprise_mappings WHERE source_id=$1 AND version=$2',[sourceId,textField(b.mappingVersion,'mappingVersion',40)])).rows[0];if(!mapping)invalid('An approved mapping version is required');
 const bytes=decode(b.contentBase64);let content:string;try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{invalid('Source file must be UTF-8');}
 let rows:unknown[];
 if(b.format==='CSV')rows=parseCsv(content);else if(b.format==='JSON'){try{const parsed=parseStrictJson(content,1048576);if(!Array.isArray(parsed))invalid('JSON original must be an array');rows=parsed;}catch(e){if(e instanceof DomainError)throw e;invalid('Source is not valid unambiguous JSON');}}else invalid('Choose CSV or JSON');
 if(!rows.length||rows.length>500)invalid('Supply 1-500 source records per batch');
 if(b.files!==undefined&&(!Array.isArray(b.files)||b.files.length>20))invalid('Supply at most 20 evidence files');
 const files=(b.files as unknown[]??[]).map(document);
 if(new Set(files.map(f=>f.documentKey)).size!==files.length)invalid('Document keys must be unique within a batch');
 if(bytes.length+files.reduce((n,f)=>n+f.bytes.length,0)>1048576)invalid('Total decoded batch must be at most 1 MiB; split larger exports');
 // Historical documents remain closed until the site's malware/content review
 // policy is approved. Byte signatures alone do not constitute malware scanning.
 if(files.length&&source.site.mode==='HISTORICAL'&&process.env.PACKPROOF_ENTERPRISE_DOCUMENT_REVIEW_APPROVED!=='true')throw new DomainError('ENTERPRISE_DOCUMENT_REVIEW_REQUIRED','Approve the pilot document scanning and handling policy before importing historical attachments',403);
 const records:Candidate[]=[],seen=new Map<string,string>();
 for(let i=0;i<rows.length;i++){
  const raw=rows[i],hash=sha256Hex(canonicalize(raw));let normalized:NormalizedRecord|null=null,errors:string[]=[];
  try{normalized=normalize(raw,mapping.dictionary);}catch(e){if(!(e instanceof DomainError))throw e;errors.push(e.message);}
  const recordKey=normalized?.recordKey??'quarantined-'+i+'-'+hash.slice(0,16),revision=normalized?.revision??'unparsed',identity=canonicalize([recordKey,revision]);
  if(seen.has(identity)&&seen.get(identity)!==hash)invalid('Conflicting bytes for one source revision in this batch');seen.set(identity,hash);
  const existing=(await db.query<{id:string;sha256:string;normalized:NormalizedRecord|null}>('SELECT id,sha256,normalized FROM enterprise_source_records WHERE source_id=$1 AND record_key=$2 AND revision=$3',[sourceId,recordKey,revision])).rows[0];
  if(existing&&existing.sha256!==hash)throw new DomainError('SOURCE_REVISION_CONFLICT','Imported revision has different bytes; supply a new revision and explicit supersedes_revision',409);
  if(existing&&canonicalize(existing.normalized)!==canonicalize(normalized))throw new DomainError('SOURCE_NORMALIZATION_CONFLICT','Existing revisions cannot be silently reinterpreted by a different mapping; supply a source correction revision',409);
  if(normalized?.lines.some(l=>!l.orderId))errors.push(normalized.candidateOrderIds.length?'AMBIGUOUS_SHIPMENT_MATCH':'MISSING_ORDER_IDENTIFIER');
  records.push({raw,sha256:hash,normalized,recordKey,revision,errors,existingId:existing?.id??null});
 }
 const previewDigest=sha256Hex(canonicalize({sourceId,mappingId:mapping.id,format:b.format,sourceSha256:sha256Hex(bytes),synthetic:b.synthetic,files:files.map(f=>({key:f.documentKey,sha256:f.sha256}))}));
 return {sourceId,siteId:source.site_id,mappingId:mapping.id,mapping:mapping.dictionary,synthetic:b.synthetic,format:String(b.format),bytes,files,records,previewDigest,warnings:['Minimize personal and commercial data before import.','Ingest hashes establish retained bytes, not physical fulfillment.','Original documents remain untrusted content.',...records.flatMap(r=>r.normalized?.warnings??[])]};
}
export function previewView(p:PreparedImport){return {schemaVersion:'packproof.enterprise.preview/v1',previewDigest:p.previewDigest,counts:{received:p.records.length,existing:p.records.filter(r=>r.existingId).length,quarantined:p.records.filter(r=>r.errors.length).length,files:p.files.length},records:p.records.map((r,index)=>({index,recordKey:r.recordKey,revision:r.revision,errors:r.errors,normalized:r.normalized})),warnings:[...new Set(p.warnings)],synthetic:p.synthetic};}
export async function archiveAsset(db:Database,clock:Clock,store:ObjectStore,siteId:string,sourceId:string,file:AssetInput){
 const objectKey='enterprise/'+siteId+'/'+sourceId+'/committed/sha256-'+file.sha256;
 if(!store.putIfAbsent)throw new DomainError('ENTERPRISE_STORAGE_UNAVAILABLE','Enterprise originals require conditional immutable writes',503);
 await store.putIfAbsent(objectKey,file.bytes,file.contentType);const meta=store.head?await store.head(objectKey):null,held=await store.get(objectKey,{versionId:meta?.versionId});
 if(!held||held.body.length!==file.bytes.length||sha256Hex(held.body)!==file.sha256)throw new DomainError('ENTERPRISE_ORIGINAL_INTEGRITY_FAILURE','Archived original failed validation',500);
 const existing=(await db.query<{id:string}>('SELECT id FROM enterprise_assets WHERE source_id=$1 AND document_key=$2 AND sha256=$3',[sourceId,file.documentKey,file.sha256])).rows[0];if(existing)return existing.id;
 const id=newId('ent_asset');await db.query('INSERT INTO enterprise_assets(id,site_id,source_id,document_key,sha256,byte_size,content_type,object_key,version_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,siteId,sourceId,file.documentKey,file.sha256,file.bytes.length,file.contentType,objectKey,meta?.versionId??null,clock.now().toISOString()]);return id;
}
async function orderLine(db:Database,clock:Clock,siteId:string,sourceId:string,orderId:string,lineId:string){
 await db.query('INSERT INTO enterprise_orders(id,site_id,source_id,external_id,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(source_id,external_id) DO NOTHING',[newId('dossier'),siteId,sourceId,orderId,clock.now().toISOString()]);
 const order=(await db.query<{id:string}>('SELECT id FROM enterprise_orders WHERE source_id=$1 AND external_id=$2',[sourceId,orderId])).rows[0];
 await db.query('INSERT INTO enterprise_order_lines(id,order_id,external_id) VALUES($1,$2,$3) ON CONFLICT(order_id,external_id) DO NOTHING',[newId('ent_line'),order.id,lineId]);
 return (await db.query<{id:string}>('SELECT id FROM enterprise_order_lines WHERE order_id=$1 AND external_id=$2',[order.id,lineId])).rows[0].id;
}
export async function activateRecord(db:Database,clock:Clock,siteId:string,sourceId:string,id:string,n:NormalizedRecord,override?:{id:string;source_id:string;external_id:string}):Promise<string|null>{
 if(n.lines.some(l=>!l.orderId)&&!override)return n.candidateOrderIds.length?'AMBIGUOUS_SHIPMENT_MATCH':'MISSING_ORDER_IDENTIFIER';
 if(n.supersedesRevision===n.revision)return 'INVALID_REVISION_CHAIN';
 await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[sourceId,n.recordKey]);
 const head=(await db.query<{record_id:string;revision:string}>(`SELECT h.record_id,r.revision FROM enterprise_record_heads h JOIN enterprise_source_records r ON r.id=h.record_id WHERE h.source_id=$1 AND h.record_key=$2 FOR UPDATE OF h`,[sourceId,n.recordKey])).rows[0];
 if(head?.record_id===id)return null;
 if(n.supersedesRevision?(head?.revision!==n.supersedesRevision):!!head)return n.supersedesRevision?'REVISION_PREDECESSOR_NOT_CURRENT':'SOURCE_REVISION_REQUIRES_SUPERSESSION';
 let fulfillment:string|null=null;const fulfillmentSource=n.fulfillmentNamespaceSourceId??sourceId;
 if(n.fulfillmentId){await db.query('INSERT INTO enterprise_fulfillments(id,site_id,source_id,external_id) VALUES($1,$2,$3,$4) ON CONFLICT(source_id,external_id) DO NOTHING',[newId('fulfill'),siteId,fulfillmentSource,n.fulfillmentId]);fulfillment=(await db.query<{id:string}>('SELECT id FROM enterprise_fulfillments WHERE source_id=$1 AND external_id=$2',[fulfillmentSource,n.fulfillmentId])).rows[0].id;}
 for(const l of n.lines){
  const line=await orderLine(db,clock,siteId,l.orderId?(n.orderNamespaceSourceId??sourceId):override!.source_id,l.orderId??override!.external_id,l.lineId);
  await db.query('INSERT INTO enterprise_assertions(id,record_id,order_line_id,fulfillment_id,stage,quantity,uom,item_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[newId('assert'),id,line,fulfillment,n.stage,l.quantity,l.uom,l.itemId]);
  for(const key of n.handlingUnitIds){await db.query('INSERT INTO enterprise_handling_units(id,source_id,external_id) VALUES($1,$2,$3) ON CONFLICT(source_id,external_id) DO NOTHING',[newId('unit'),sourceId,key]);const unit=(await db.query<{id:string}>('SELECT id FROM enterprise_handling_units WHERE source_id=$1 AND external_id=$2',[sourceId,key])).rows[0];await db.query('INSERT INTO enterprise_handling_unit_lines(record_id,handling_unit_id,order_line_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,unit.id,line]);}
 }
 for(const key of n.documentKeys){const assets=(await db.query<{id:string}>('SELECT id FROM enterprise_assets WHERE source_id=$1 AND document_key=$2',[sourceId,key])).rows;if(assets.length===1)await db.query('INSERT INTO enterprise_record_assets(record_id,asset_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,assets[0].id]);}
 await db.query('INSERT INTO enterprise_record_heads(source_id,record_key,record_id) VALUES($1,$2,$3) ON CONFLICT(source_id,record_key) DO UPDATE SET record_id=$3',[sourceId,n.recordKey,id]);return null;
}
export async function commitImport(db:Database,clock:Clock,store:ObjectStore,a:EnterpriseActor,input:unknown){
 const p=await prepareImport(db,clock,a,input),body=record(input);if(body.previewDigest!==p.previewDigest)throw new DomainError('IMPORT_PREVIEW_REQUIRED','Preview the exact source, mapping and original files before committing',409);
 const id=newId('import'),original=await archiveAsset(db,clock,store,p.siteId,p.sourceId,{documentKey:'import-original-'+sha256Hex(p.bytes),contentType:p.format==='CSV'?'text/csv':'application/json',bytes:p.bytes,sha256:sha256Hex(p.bytes)});
 const assets=[];for(const f of p.files)assets.push({id:await archiveAsset(db,clock,store,p.siteId,p.sourceId,f),documentKey:f.documentKey,sha256:f.sha256,byteSize:f.bytes.length});
 const manifest={schemaVersion:'packproof.enterprise.manifest/v1',sourceId:p.sourceId,siteId:p.siteId,mappingId:p.mappingId,synthetic:p.synthetic,source:{assetId:original,sha256:sha256Hex(p.bytes),byteSize:p.bytes.length},assets,records:p.records.map(r=>({recordKey:r.recordKey,revision:r.revision,sha256:r.sha256}))};
 const counts={received:p.records.length,inserted:0,duplicates:0,quarantined:0},results:{id:string;recordKey:string;errors:string[]}[]=[];
 await db.query('INSERT INTO enterprise_imports(id,site_id,source_id,mapping_id,original_asset_id,manifest,manifest_sha256,counts,actor_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10)',[id,p.siteId,p.sourceId,p.mappingId,original,JSON.stringify(manifest),sha256Hex(canonicalize(manifest)),JSON.stringify({received:p.records.length}),a.userId,clock.now().toISOString()]);
 for(const c of p.records){
  const n=c.normalized,inserted=await db.query<{id:string}>('INSERT INTO enterprise_source_records(id,source_id,import_id,record_key,revision,supersedes_revision,sha256,raw_payload,normalized,errors,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11) ON CONFLICT(source_id,record_key,revision) DO NOTHING RETURNING id',[c.existingId??newId('source_record'),p.sourceId,id,c.recordKey,c.revision,n?.supersedesRevision??null,c.sha256,JSON.stringify(c.raw),JSON.stringify(n),JSON.stringify(c.errors),clock.now().toISOString()]);
  const current=(await db.query<{id:string;sha256:string;normalized:NormalizedRecord|null}>('SELECT id,sha256,normalized FROM enterprise_source_records WHERE source_id=$1 AND record_key=$2 AND revision=$3',[p.sourceId,c.recordKey,c.revision])).rows[0];
  if(current.sha256!==c.sha256||canonicalize(current.normalized)!==canonicalize(c.normalized))throw new DomainError('SOURCE_REVISION_CONFLICT','Concurrent import changed this source revision',409);
  if(inserted.rows.length)counts.inserted++;else counts.duplicates++;results.push({id:current.id,recordKey:c.recordKey,errors:n?[]:c.errors});
 }
 const pending=results.map((r,i)=>({r,n:p.records[i].normalized})).filter(x=>x.n);
 for(let pass=0;pass<=p.records.length&&pending.length;pass++){
  let progress=false;
  for(let i=pending.length-1;i>=0;i--){const item=pending[i];if((await db.query('SELECT 1 FROM enterprise_assertions WHERE record_id=$1 LIMIT 1',[item.r.id])).rows[0]){item.r.errors=[];pending.splice(i,1);progress=true;continue;}
   const error=await activateRecord(db,clock,p.siteId,p.sourceId,item.r.id,item.n!);if(!error){item.r.errors=[];pending.splice(i,1);progress=true;}else item.r.errors=[error];}
  if(!progress)break;
 }
 // Late-arriving originals acquire an association only when the native
 // document key has one retained content version in this source namespace.
 await db.query(`INSERT INTO enterprise_record_assets(record_id,asset_id)
 SELECT r.id,e.id FROM enterprise_source_records r JOIN enterprise_assets e ON e.source_id=r.source_id
 WHERE r.source_id=$1 AND r.normalized->'documentKeys' ? e.document_key
 AND (SELECT count(*) FROM enterprise_assets v WHERE v.source_id=e.source_id AND v.document_key=e.document_key)=1
 ON CONFLICT DO NOTHING`,[p.sourceId]);
 counts.quarantined=results.filter(r=>r.errors.length).length;await audit(db,clock,a,p.siteId,'IMPORT_COMMITTED',id,{...counts,manifestSha256:sha256Hex(canonicalize(manifest))});
 return {id,counts,records:results,manifest,manifestSha256:sha256Hex(canonicalize(manifest)),synthetic:p.synthetic};
}
export async function importStatus(db:Database,clock:Clock,a:EnterpriseActor,id:string){
 const b=(await db.query<{site_id:string;source_id:string;manifest:unknown;manifest_sha256:string;created_at:string}>('SELECT site_id,source_id,manifest,manifest_sha256,created_at FROM enterprise_imports WHERE id=$1',[id])).rows[0];if(!b)throw absent();await requireSource(db,clock,a,b.source_id);
 const records=(await db.query(`SELECT r.id,r.record_key,r.revision,r.errors,r.normalized IS NULL AS invalid,EXISTS(SELECT 1 FROM enterprise_assertions a WHERE a.record_id=r.id) AS associated,EXISTS(SELECT 1 FROM enterprise_record_heads h WHERE h.record_id=r.id) AS current FROM enterprise_source_records r WHERE r.import_id=$1 ORDER BY r.id`,[id])).rows;return {id,...b,records,counts:{received:records.length,associated:records.filter(r=>r.associated).length,quarantined:records.filter(r=>!r.associated).length}};
}
export async function resolveRecord(db:Database,clock:Clock,a:EnterpriseActor,siteId:string,id:string,input:unknown){
 await requireSite(db,clock,a,siteId,['ADMIN','REVIEWER']);const b=strictBody(input,['dossierId','reason']),target=(await db.query<{id:string;source_id:string;external_id:string}>('SELECT id,source_id,external_id FROM enterprise_orders WHERE id=$1 AND site_id=$2',[textField(b.dossierId,'dossierId'),siteId])).rows[0];if(!target)throw absent();
 const row=(await db.query<{source_id:string;normalized:NormalizedRecord}>(`SELECT r.source_id,r.normalized FROM enterprise_source_records r JOIN enterprise_sources s ON s.id=r.source_id WHERE r.id=$1 AND s.site_id=$2`,[id,siteId])).rows[0];if(!row||!row.normalized)throw absent();
 if((await db.query('SELECT 1 FROM enterprise_assertions WHERE record_id=$1',[id])).rows[0])throw new DomainError('ASSOCIATION_ALREADY_RECORDED','Association is already recorded; annotate rather than rewrite it',409);
 if(row.normalized.lines.every(l=>!!l.orderId))throw new DomainError('SOURCE_ASSOCIATION_EXPLICIT','Resolve the source revision chain rather than replacing explicit identifiers',409);
 const reason=textField(b.reason,'reason',2000),error=await activateRecord(db,clock,siteId,row.source_id,id,row.normalized,target);if(error)throw new DomainError('ASSOCIATION_UNRESOLVED',error,409);
 await db.query('INSERT INTO enterprise_link_decisions(id,record_id,order_id,reason,actor_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',[newId('link'),id,target.id,reason,a.userId,clock.now().toISOString()]);await audit(db,clock,a,siteId,'ASSOCIATION_CONFIRMED',id,{dossierId:target.id});return {recordId:id,dossierId:target.id,association:'REVIEWER_CONFIRMED',businessClaimSupported:false};
}
