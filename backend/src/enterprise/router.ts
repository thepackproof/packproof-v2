import express,{type Request,type Response,type NextFunction} from 'express';
import type { AppDependencies } from '../app.js';
import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { idempotent } from '../platform/idempotency.js';
import { organizationAdmin } from '../platform/organizations.js';
import { distributedRateLimit } from '../http/boundary.js';
import { authenticateEnterprise,requireSite,requireSource,requireEnterpriseFeature,listSites,createSite,grantMember,createSource,addMapping,grantSource,audit,absent,type EnterpriseActor,type SiteRole } from './access.js';
import { prepareImport,previewView,commitImport,importStatus,resolveRecord,activateRecord } from './imports.js';
import { dossierView,searchDossiers,sourceDiagnostics,readOriginal,readSourceRecord,readImportOriginal,annotate,exportDossier,auditExport,requireDossier } from './dossiers.js';
import { startMeasurement,finishMeasurement,pilotMetrics } from './measurements.js';
import { canonicalMapping,type NormalizedRecord } from './contracts.js';
import { loadSyntheticExamples } from './demo.js';
type EnterpriseRequest=Request&{enterpriseActor:EnterpriseActor};
type Context=(db:Database,a:EnterpriseActor,r:EnterpriseRequest)=>Promise<{tenantId:string}>;
const run=(fn:(q:EnterpriseRequest,s:Response)=>Promise<void>)=>(q:Request,s:Response,n:NextFunction)=>{void fn(q as EnterpriseRequest,s).catch(n);};
export function enterpriseRouter(deps:AppDependencies){
 const r=express.Router();
 r.use((_q,s,n)=>{s.setHeader('Cache-Control','private, no-store');s.setHeader('X-Content-Type-Options','nosniff');s.setHeader('Referrer-Policy','no-referrer');s.setHeader('PackProof-API-Profile','packproof.enterprise/v1');try{requireEnterpriseFeature();n();}catch(e){n(e);}});
 r.use(distributedRateLimit(deps.db,{scope:'enterprise-ingress',limit:120,windowMs:60000}));
 r.use((q,s,n)=>{void authenticateEnterprise(deps.db,deps.clock,deps.auth,q.headers,s.locals.operationId).then(a=>{(q as EnterpriseRequest).enterpriseActor=a;n();}).catch(n);});
 r.use(distributedRateLimit(deps.db,{scope:'enterprise-actor',limit:120,windowMs:60000,subject:q=>(q as EnterpriseRequest).enterpriseActor.userId}));
 async function tenant(db:Database,id:string){const o=(await db.query<{tenant_id:string}>('SELECT tenant_id FROM platform_organizations WHERE id=$1 AND enabled=true',[id])).rows[0];if(!o?.tenant_id)throw absent();return {tenantId:o.tenant_id};}
 const site=(roles?:SiteRole[]):Context=>async(db,a,q)=>{const s=await requireSite(db,deps.clock,a,q.params.siteId??String(q.query.siteId??''),roles);return tenant(db,s.organization_id);};
 const source=(roles?:SiteRole[]):Context=>async(db,a,q)=>{const s=await requireSource(db,deps.clock,a,q.params.sourceId??String(q.body?.sourceId??''),roles);return tenant(db,s.site.organization_id);};
 const dossier=(roles?:SiteRole[]):Context=>async(db,a,q)=>{const d=await requireDossier(db,deps.clock,a,q.params.dossierId??q.params.caseId,roles);return tenant(db,d.site.organization_id);};
 const batch:Context=async(db,a,q)=>{const b=(await db.query<{source_id:string}>('SELECT source_id FROM enterprise_imports WHERE id=$1',[q.params.batchId])).rows[0];if(!b)throw absent();const s=await requireSource(db,deps.clock,a,b.source_id);return tenant(db,s.site.organization_id);};
 const org:Context=async(db,a,q)=>{if(a.partner)throw absent();const o=await organizationAdmin(db,a.userId,String(q.body?.organizationId??''));if(!o.enabled||!o.tenant_id)throw absent();return {tenantId:o.tenant_id};};
 function read(path:string,check:Context,fn:(db:Database,a:EnterpriseActor,q:EnterpriseRequest)=>Promise<unknown>){r.get(path,run(async(q,s)=>{await check(deps.db,q.enterpriseActor,q);const v=await fn(deps.db,q.enterpriseActor,q);await check(deps.db,q.enterpriseActor,q);s.json(v);}));}
 function write(path:string,check:Context,fn:(db:Database,a:EnterpriseActor,q:EnterpriseRequest)=>Promise<unknown>,status=201){r.post(path,run(async(q,s)=>{
  if(!q.is('application/json'))throw new DomainError('UNSUPPORTED_CONTENT_TYPE','Enterprise commands accept JSON envelopes',415);
  const a=q.enterpriseActor,c=await check(deps.db,a,q),operation='enterprise/v1:'+a.userId+':'+(a.partner?.credentialId??'human')+':'+q.path;
  const result=await idempotent(deps.db,deps.clock,c.tenantId,operation,q.header('Idempotency-Key'),q.body,async tx=>{await check(tx,a,q);return fn(tx,a,q);});
  await check(deps.db,a,q);s.setHeader('Idempotency-Replayed',String(result.replayed));s.status(status).json(result.value);
 }));}
 r.get('/capabilities',run(async(q,s)=>{if(q.enterpriseActor.partner)throw absent();s.json({schemaVersion:'packproof.enterprise.capabilities/v1',enabled:true,historicalEnabled:process.env.PACKPROOF_ENTERPRISE_HISTORICAL_ENABLED==='true',maxBatchBytes:1048576,maxRecords:500,canonicalMapping,externalWriteback:false,recurringConnectorEnabled:false});}));
 r.get('/sites',run(async(q,s)=>{s.json(await listSites(deps.db,deps.clock,q.enterpriseActor));}));
 write('/sites',org,(db,a,q)=>createSite(db,deps.clock,a,q.body));
 write('/sites/:siteId/members',site(['ADMIN']),(db,a,q)=>grantMember(db,deps.clock,a,q.params.siteId,q.body));
 write('/sites/:siteId/sources',site(['ADMIN']),(db,a,q)=>createSource(db,deps.clock,a,q.params.siteId,q.body));
 write('/sites/:siteId/synthetic-examples',site(['ADMIN']),(db,a,q)=>loadSyntheticExamples(db,deps.clock,deps.objectStore,a,q.params.siteId));
 read('/sites/:siteId/diagnostics',site(['ADMIN','IMPORTER','REVIEWER']),(db,a,q)=>sourceDiagnostics(db,deps.clock,a,q.params.siteId));
 write('/sources/:sourceId/mappings',source(['ADMIN']),(db,a,q)=>addMapping(db,deps.clock,a,q.params.sourceId,q.body));
 write('/sources/:sourceId/service-grants',source(['ADMIN']),(db,a,q)=>grantSource(db,deps.clock,a,q.params.sourceId,q.body));
 r.post('/imports/preview',run(async(q,s)=>{if(!q.is('application/json'))throw new DomainError('UNSUPPORTED_CONTENT_TYPE','Use a JSON import envelope',415);await source()(deps.db,q.enterpriseActor,q);const p=await prepareImport(deps.db,deps.clock,q.enterpriseActor,q.body);await audit(deps.db,deps.clock,q.enterpriseActor,p.siteId,'IMPORT_PREVIEWED',p.sourceId,{received:p.records.length});await source()(deps.db,q.enterpriseActor,q);s.json(previewView(p));}));
 write('/imports',source(),(db,a,q)=>commitImport(db,deps.clock,deps.objectStore,a,q.body));
 read('/imports/:batchId',batch,(db,a,q)=>importStatus(db,deps.clock,a,q.params.batchId));
 r.get('/imports/:batchId/original',run(async(q,s)=>{await batch(deps.db,q.enterpriseActor,q);const v=await readImportOriginal(deps.db,deps.clock,deps.objectStore,q.enterpriseActor,q.params.batchId);sendOriginal(s,v,'source-original');}));
 write('/sites/:siteId/records/:recordId/resolve',site(['ADMIN','REVIEWER']),(db,a,q)=>resolveRecord(db,deps.clock,a,q.params.siteId,q.params.recordId,q.body));
 write('/imports/:batchId/replay',batch,async(db,a,q)=>{
  const b=(await db.query<{site_id:string;source_id:string}>('SELECT site_id,source_id FROM enterprise_imports WHERE id=$1',[q.params.batchId])).rows[0];
  const pending=(await db.query<{id:string;normalized:NormalizedRecord}>(`SELECT r.id,r.normalized FROM enterprise_source_records r WHERE r.import_id=$1 AND r.normalized IS NOT NULL AND NOT EXISTS(SELECT 1 FROM enterprise_assertions a WHERE a.record_id=r.id) ORDER BY r.id`,[q.params.batchId])).rows;
  const results=[];for(const item of pending)results.push({id:item.id,error:await activateRecord(db,deps.clock,b.site_id,b.source_id,item.id,item.normalized)});
  await audit(db,deps.clock,a,b.site_id,'IMPORT_REPLAYED',q.params.batchId,{attempted:pending.length});return {results};
 },200);
 read('/dossiers',site(),(db,a,q)=>searchDossiers(db,deps.clock,a,q.query));
 read('/dossiers/:dossierId',dossier(),(db,a,q)=>dossierView(db,deps.clock,a,q.params.dossierId));
 read('/dossiers/:dossierId/timeline',dossier(),async(db,a,q)=>({timeline:(await dossierView(db,deps.clock,a,q.params.dossierId)).timeline}));
 read('/dossiers/:dossierId/reconciliation',dossier(),async(db,a,q)=>(await dossierView(db,deps.clock,a,q.params.dossierId)).reconciliation);
 read('/dossiers/:dossierId/records/:recordId',dossier(),(db,a,q)=>readSourceRecord(db,deps.clock,a,q.params.dossierId,q.params.recordId));
 r.get('/dossiers/:dossierId/evidence/:assetId',run(async(q,s)=>{await dossier()(deps.db,q.enterpriseActor,q);const v=await readOriginal(deps.db,deps.clock,deps.objectStore,q.enterpriseActor,q.params.dossierId,q.params.assetId);sendOriginal(s,v,'evidence-original');}));
 write('/reviews/:caseId/annotations',dossier(['ADMIN','REVIEWER']),(db,a,q)=>annotate(db,deps.clock,a,q.params.caseId,q.body));
 write('/dossiers/:dossierId/annotations',dossier(['ADMIN','REVIEWER']),(db,a,q)=>annotate(db,deps.clock,a,q.params.dossierId,q.body));
 read('/dossiers/:dossierId/export',dossier(['ADMIN','REVIEWER']),(db,a,q)=>exportDossier(db,deps.clock,a,q.params.dossierId));
 write('/dossiers/:dossierId/measurements',dossier(['ADMIN','REVIEWER']),(db,a,q)=>startMeasurement(db,deps.clock,a,q.params.dossierId,q.body));
 const measurement:Context=async(db,a,q)=>{const m=(await db.query<{order_id:string;reviewer_id:string}>('SELECT order_id,reviewer_id FROM enterprise_measurements WHERE id=$1',[q.params.measurementId])).rows[0];if(!m||m.reviewer_id!==a.userId)throw absent();const d=await requireDossier(db,deps.clock,a,m.order_id,['ADMIN','REVIEWER']);return tenant(db,d.site.organization_id);};
 write('/measurements/:measurementId/finish',measurement,(db,a,q)=>finishMeasurement(db,deps.clock,a,q.params.measurementId,q.body));
 read('/pilot/metrics',site(['ADMIN','REVIEWER']),(db,a,q)=>pilotMetrics(db,deps.clock,a,String(q.query.siteId)));
 read('/sites/:siteId/audit',site(['ADMIN']),(db,a,q)=>auditExport(db,deps.clock,a,q.params.siteId,q.query.after));
 r.use((_q,_s,n)=>n(new DomainError('ENTERPRISE_ROUTE_NOT_FOUND','Enterprise endpoint not found',404)));return r;
}
function sendOriginal(s:Response,v:{bytes:Buffer;contentType:string;sha256:string},name:string){
 const ext=v.contentType==='application/pdf'?'pdf':v.contentType==='image/png'?'png':v.contentType==='image/jpeg'?'jpg':v.contentType==='text/csv'?'csv':'json';
 s.setHeader('Content-Disposition','attachment; filename="'+name+'.'+ext+'"');s.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");s.setHeader('X-PackProof-Original-SHA256',v.sha256);s.type(v.contentType).send(v.bytes);
}
