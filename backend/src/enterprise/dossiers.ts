import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import type { ObjectStore } from '../s3/object-store.js';
import { newId } from '../ids.js';
import { sha256Hex } from '../hash.js';
import { DomainError } from '../domain/errors.js';
import { canonicalize } from '../canonical.js';
import { strictBody } from '../platform/organizations.js';
import { textField } from '../platform/tenants.js';
import { requireSite,requireSource,audit,absent,type EnterpriseActor,type SiteRole } from './access.js';
import { reconcile,exception,type Assertion } from './reconciliation.js';
import type { NormalizedRecord } from './contracts.js';
export interface OrderRow {id:string;site_id:string;source_id:string;external_id:string;created_at:string;}
export async function requireDossier(db:Database,clock:Clock,a:EnterpriseActor,id:string,roles?:SiteRole[]){
 const row=(await db.query<OrderRow>('SELECT * FROM enterprise_orders WHERE id=$1',[id])).rows[0];if(!row)throw absent();const site=await requireSite(db,clock,a,row.site_id,roles);return {order:row,site};
}
export async function dossierView(db:Database,clock:Clock,a:EnterpriseActor,id:string,log=true){
 const {order,site}=await requireDossier(db,clock,a,id);
 const assertions=(await db.query<Assertion>(`SELECT a.id,a.record_id,a.order_line_id,l.external_id AS line_external_id,a.fulfillment_id,f.external_id AS fulfillment_external_id,a.stage,a.quantity::text,a.uom,a.item_id
 FROM enterprise_assertions a JOIN enterprise_order_lines l ON l.id=a.order_line_id JOIN enterprise_record_heads h ON h.record_id=a.record_id
 LEFT JOIN enterprise_fulfillments f ON f.id=a.fulfillment_id WHERE l.order_id=$1 ORDER BY l.external_id,a.id`,[id])).rows;
 const records=(await db.query<{id:string;record_key:string;revision:string;source_id:string;source_name:string;import_id:string;normalized:NormalizedRecord;created_at:string;association:string}>(`SELECT DISTINCT r.id,r.record_key,r.revision,r.source_id,s.name AS source_name,r.import_id,r.normalized,r.created_at,
 CASE WHEN EXISTS(SELECT 1 FROM enterprise_link_decisions d WHERE d.record_id=r.id) THEN 'REVIEWER_CONFIRMED' ELSE 'SOURCE_IDENTIFIER' END AS association
 FROM enterprise_source_records r JOIN enterprise_record_heads h ON h.record_id=r.id JOIN enterprise_sources s ON s.id=r.source_id
 JOIN enterprise_assertions a ON a.record_id=r.id JOIN enterprise_order_lines l ON l.id=a.order_line_id WHERE l.order_id=$1`,[id])).rows;
 const linkedAssets=(await db.query<{id:string;document_key:string;sha256:string;byte_size:number;content_type:string;record_id:string}>(`SELECT DISTINCT e.id,e.document_key,e.sha256,e.byte_size,e.content_type,ra.record_id FROM enterprise_assets e
 JOIN enterprise_record_assets ra ON ra.asset_id=e.id JOIN enterprise_record_heads h ON h.record_id=ra.record_id JOIN enterprise_assertions a ON a.record_id=ra.record_id
 JOIN enterprise_order_lines l ON l.id=a.order_line_id WHERE l.order_id=$1 AND (SELECT count(*) FROM enterprise_assets v WHERE v.source_id=e.source_id AND v.document_key=e.document_key)=1 ORDER BY e.id`,[id])).rows;
 const reconciliation=reconcile(assertions);
 for(const r of records){
  if(r.normalized.timeConfidence==='UNKNOWN'||r.normalized.timeConfidence==='AMBIGUOUS')reconciliation.exceptions.push(exception('SOURCE_TIMESTAMP_'+r.normalized.timeConfidence,null,[r.id],'Source time cannot be placed precisely in chronology.','Local timestamp and timezone are retained; ingest time is separate.'));
  for(const key of r.normalized.documentKeys){const matches=(await db.query<{id:string}>('SELECT id FROM enterprise_assets WHERE source_id=$1 AND document_key=$2',[r.source_id,key])).rows;if(matches.length!==1)reconciliation.exceptions.push(exception(matches.length?'AMBIGUOUS_EVIDENCE_REVISION':'SOURCE_DOCUMENT_NOT_FOUND',null,[r.id],'Document '+key+' has '+matches.length+' eligible original versions.','Do not infer document identity without an unambiguous source version.'));}
 }
 const sources=(await db.query<{id:string;name:string;freshness_hours:number;last_import_at:string|null}>(`SELECT s.id,s.name,s.freshness_hours,MAX(i.created_at)::text AS last_import_at FROM enterprise_sources s LEFT JOIN enterprise_imports i ON i.source_id=s.id
 WHERE s.site_id=$1 GROUP BY s.id,s.name,s.freshness_hours ORDER BY s.id`,[site.id])).rows.map(s=>({...s,stale:!s.last_import_at||clock.now().getTime()-new Date(s.last_import_at).getTime()>s.freshness_hours*3600000}));
 for(const s of sources.filter(s=>s.stale))reconciliation.exceptions.push(exception('STALE_SOURCE',null,[],'Source '+s.name+' is older than its configured freshness window.','Freshness uses successful PackProof imports, not upstream truth.'));
 const timeline=records.map(r=>({id:r.id,recordKey:r.record_key,revision:r.revision,sourceId:r.source_id,sourceName:r.source_name,importId:r.import_id,stage:r.normalized.stage,fulfillmentId:r.normalized.fulfillmentId,customerPo:r.normalized.customerPo,
 occurredAtLocal:r.normalized.occurredAtLocal,sourceTimezone:r.normalized.sourceTimezone,occurredAtUtc:r.normalized.occurredAtUtc,timeConfidence:r.normalized.timeConfidence,ingestedAt:r.created_at,association:r.association,provenance:'SOURCE_ASSERTED',businessClaimSupported:false,
 lines:assertions.filter(x=>x.record_id===r.id),evidence:linkedAssets.filter(x=>x.record_id===r.id),warnings:r.normalized.warnings,handlingUnitIds:r.normalized.handlingUnitIds})).sort((x,y)=>x.occurredAtUtc&&y.occurredAtUtc?x.occurredAtUtc.localeCompare(y.occurredAtUtc)||x.id.localeCompare(y.id):x.occurredAtUtc?-1:y.occurredAtUtc?1:x.id.localeCompare(y.id));
 const annotations=(await db.query('SELECT * FROM enterprise_annotations WHERE order_id=$1 ORDER BY created_at,id',[id])).rows;
 const decisions=(await db.query('SELECT * FROM enterprise_link_decisions WHERE order_id=$1 ORDER BY created_at,id',[id])).rows;
 if(log)await audit(db,clock,a,site.id,'DOSSIER_VIEWED',id);
 return {schemaVersion:'packproof.enterprise.dossier/v1',id,externalId:order.external_id,site:{id:site.id,name:site.name,mode:site.mode,fulfillmentMode:site.fulfillment_mode},synthetic:site.mode==='SYNTHETIC',
 sourceId:order.source_id,lastKnownEvent:timeline.filter(t=>t.occurredAtUtc).at(-1)??null,sources,fulfillments:[...new Set(assertions.map(x=>x.fulfillment_external_id).filter(Boolean))],reconciliation,timeline,evidence:linkedAssets,annotations,associationDecisions:decisions,
 confidence:{sourceRecordPresent:records.length>0,associationConfidence:decisions.length?'REVIEWER_AND_SOURCE':'SOURCE_IDENTIFIER',coverage:reconciliation.lines.map(l=>({lineId:l.id,stages:Object.keys(l.stages)})),integrityVerifiedAtIngest:true,businessClaimSupported:false},
 notice:'Source assertions and PackProof ingest integrity are separate. Unknown is not zero. No fault or dispute outcome is assigned.'};
}
export async function searchDossiers(db:Database,clock:Clock,a:EnterpriseActor,q:Record<string,unknown>){
 const siteId=textField(q.siteId,'siteId');await requireSite(db,clock,a,siteId);const after=q.after?textField(q.after,'after'):null,external=q.externalId?(textField(q.externalId,'externalId'),q.externalId as string):null;
 const date=(v:unknown)=>{if(v==null||v==='')return null;if(typeof v!=='string'||!/^\d{4}-\d\d-\d\d$/.test(v)||!Number.isFinite(Date.parse(v+'T00:00:00Z'))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)throw new DomainError('INVALID_REQUEST','Use valid YYYY-MM-DD filters',400);return v;};const from=date(q.from),to=date(q.to);
 const rows=(await db.query<OrderRow>(`SELECT o.* FROM enterprise_orders o WHERE o.site_id=$1 AND ($2::text IS NULL OR o.id>$2)
 AND ($3::text IS NULL OR o.external_id=$3 OR EXISTS(SELECT 1 FROM enterprise_assertions a JOIN enterprise_order_lines l ON l.id=a.order_line_id LEFT JOIN enterprise_fulfillments f ON f.id=a.fulfillment_id JOIN enterprise_source_records r ON r.id=a.record_id JOIN enterprise_record_heads h ON h.record_id=r.id WHERE l.order_id=o.id AND (f.external_id=$3 OR r.normalized->>'customerPo'=$3)))
 AND ($4::text IS NULL OR o.created_at>=$4::date) AND ($5::text IS NULL OR o.created_at<($5::date+INTERVAL '1 day')) ORDER BY o.id LIMIT 26`,[siteId,after,external,from,to])).rows;
 const page=rows.slice(0,25),items=[];for(const row of page){const d=await dossierView(db,clock,a,row.id,false);items.push({id:d.id,externalId:d.externalId,synthetic:d.synthetic,fulfillments:d.fulfillments,exceptionCount:d.reconciliation.exceptions.length,lastKnownEvent:d.lastKnownEvent,sources:d.sources});}
 await audit(db,clock,a,siteId,'DOSSIER_SEARCH',undefined,{returned:items.length});return {items,nextCursor:rows.length>25?page.at(-1)!.id:null,dateFilter:'PACKPROOF_IMPORT_DATE'};
}
export async function sourceDiagnostics(db:Database,clock:Clock,a:EnterpriseActor,siteId:string){
 await requireSite(db,clock,a,siteId,['ADMIN','IMPORTER','REVIEWER']);
 const sources=(await db.query('SELECT * FROM enterprise_sources WHERE site_id=$1 ORDER BY name,id',[siteId])).rows;
 const mappings=(await db.query('SELECT m.* FROM enterprise_mappings m JOIN enterprise_sources s ON s.id=m.source_id WHERE s.site_id=$1 ORDER BY m.created_at,m.id',[siteId])).rows;
 const imports=(await db.query('SELECT id,source_id,mapping_id,manifest_sha256,counts,created_at FROM enterprise_imports WHERE site_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',[siteId])).rows;
 const quarantine=(await db.query(`SELECT r.id,r.source_id,r.record_key,r.revision,r.normalized,r.errors,r.import_id FROM enterprise_source_records r JOIN enterprise_sources s ON s.id=r.source_id WHERE s.site_id=$1 AND NOT EXISTS(SELECT 1 FROM enterprise_assertions a WHERE a.record_id=r.id) ORDER BY r.created_at,r.id LIMIT 100`,[siteId])).rows;
 const unassociated=(await db.query(`SELECT e.id,e.source_id,e.document_key,e.sha256,e.content_type FROM enterprise_assets e WHERE e.site_id=$1 AND e.content_type IN ('application/pdf','image/png','image/jpeg') AND NOT EXISTS(SELECT 1 FROM enterprise_record_assets ra WHERE ra.asset_id=e.id) ORDER BY e.id LIMIT 100`,[siteId])).rows;
 await audit(db,clock,a,siteId,'SOURCE_DIAGNOSTICS_VIEWED',siteId);return {sources,mappings,imports,quarantine,unassociatedEvidence:unassociated,limit:100};
}
export async function readOriginal(db:Database,clock:Clock,store:ObjectStore,a:EnterpriseActor,dossierId:string,assetId:string){
 const {order}=await requireDossier(db,clock,a,dossierId);
 const asset=(await db.query<{id:string;object_key:string;version_id:string|null;sha256:string;byte_size:number;content_type:string}>(`SELECT DISTINCT e.* FROM enterprise_assets e JOIN enterprise_record_assets ra ON ra.asset_id=e.id JOIN enterprise_assertions a ON a.record_id=ra.record_id JOIN enterprise_order_lines l ON l.id=a.order_line_id WHERE e.id=$1 AND e.site_id=$2 AND l.order_id=$3`,[assetId,order.site_id,dossierId])).rows[0];if(!asset)throw absent();
 const original=await store.get(asset.object_key,{versionId:asset.version_id});
 if(!original||original.body.length!==asset.byte_size||sha256Hex(original.body)!==asset.sha256)throw new DomainError('ENTERPRISE_ORIGINAL_INTEGRITY_FAILURE','Original bytes could not be verified',409);
 await requireDossier(db,clock,a,dossierId);await audit(db,clock,a,order.site_id,'ORIGINAL_VIEWED',assetId,{sha256:asset.sha256});return {bytes:original.body,contentType:asset.content_type,sha256:asset.sha256};
}
export async function readSourceRecord(db:Database,clock:Clock,a:EnterpriseActor,dossierId:string,recordId:string){
 const {order}=await requireDossier(db,clock,a,dossierId);
 const row=(await db.query(`SELECT DISTINCT r.id,r.raw_payload,r.normalized,r.sha256,r.record_key,r.revision,r.created_at,i.original_asset_id,i.manifest,i.manifest_sha256 FROM enterprise_source_records r JOIN enterprise_imports i ON i.id=r.import_id JOIN enterprise_assertions a ON a.record_id=r.id JOIN enterprise_order_lines l ON l.id=a.order_line_id WHERE l.order_id=$1 AND r.id=$2`,[dossierId,recordId])).rows[0];if(!row)throw absent();await audit(db,clock,a,order.site_id,'SOURCE_RECORD_VIEWED',recordId);return row;
}
export async function readImportOriginal(db:Database,clock:Clock,store:ObjectStore,a:EnterpriseActor,batchId:string){
 if(a.partner)throw absent();
 const b=(await db.query<{source_id:string;original_asset_id:string}>('SELECT source_id,original_asset_id FROM enterprise_imports WHERE id=$1',[batchId])).rows[0];if(!b)throw absent();const source=await requireSource(db,clock,a,b.source_id);
 const asset=(await db.query<{object_key:string;version_id:string|null;sha256:string;content_type:string}>('SELECT object_key,version_id,sha256,content_type FROM enterprise_assets WHERE id=$1',[b.original_asset_id])).rows[0],held=await store.get(asset.object_key,{versionId:asset.version_id});
 if(!held||sha256Hex(held.body)!==asset.sha256)throw new DomainError('ENTERPRISE_ORIGINAL_INTEGRITY_FAILURE','Original import failed validation',409);
 await requireSource(db,clock,a,b.source_id);await audit(db,clock,a,source.site_id,'IMPORT_ORIGINAL_EXPORTED',batchId,{sha256:asset.sha256});return {bytes:held.body,contentType:asset.content_type,sha256:asset.sha256};
}
export async function annotate(db:Database,clock:Clock,a:EnterpriseActor,id:string,input:unknown){
 const {order}=await requireDossier(db,clock,a,id,['ADMIN','REVIEWER']),b=strictBody(input,['exceptionKey','disposition','reason']);
 if(!['NOTE','EXPLAINED','EXPECTED','NEEDS_FOLLOW_UP'].includes(String(b.disposition)))throw new DomainError('INVALID_REQUEST','Choose a reviewer disposition',400);
 const exceptionKey=b.exceptionKey==null?null:textField(b.exceptionKey,'exceptionKey',64);
 if(exceptionKey){const v=await dossierView(db,clock,a,id,false);if(!v.reconciliation.exceptions.some(e=>e.key===exceptionKey))throw new DomainError('EXCEPTION_NOT_FOUND','Exception is not in the current view',409);}
 const annotationId=newId('annotation');await db.query('INSERT INTO enterprise_annotations(id,order_id,exception_key,disposition,reason,actor_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[annotationId,id,exceptionKey,b.disposition,textField(b.reason,'reason',4000),a.userId,clock.now().toISOString()]);await audit(db,clock,a,order.site_id,'REVIEW_ANNOTATION_CREATED',annotationId);return {id:annotationId};
}
export async function exportDossier(db:Database,clock:Clock,a:EnterpriseActor,id:string){
 const {order}=await requireDossier(db,clock,a,id,['ADMIN','REVIEWER']),dossier=await dossierView(db,clock,a,id,false),records=[];for(const event of dossier.timeline)records.push(await readSourceRecord(db,clock,a,id,event.id));
 const summary={schemaVersion:'packproof.enterprise.case-export/v1',generatedAt:clock.now().toISOString(),dossier,sourceRecords:records};await audit(db,clock,a,order.site_id,'DOSSIER_EXPORTED',id);return {...summary,exportSha256:sha256Hex(canonicalize(summary))};
}
export async function auditExport(db:Database,clock:Clock,a:EnterpriseActor,siteId:string,after?:unknown){
 await requireSite(db,clock,a,siteId,['ADMIN']);const cursor=after==null?null:textField(after,'after'),rows=(await db.query('SELECT * FROM enterprise_audit WHERE site_id=$1 AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT 501',[siteId,cursor])).rows;
 await audit(db,clock,a,siteId,'AUDIT_EXPORTED',siteId);return {items:rows.slice(0,500),nextCursor:rows.length>500?rows[499].id:null};
}
