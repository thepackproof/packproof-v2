import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import type { AuthenticationAdapter } from '../auth/adapter.js';
import { DomainError } from '../domain/errors.js';
import { requireActiveAccount } from '../domain/account-access.js';
import { assertPolicyAccessSafe } from '../domain/policy-recovery.js';
import { requireHumanActor } from '../platform/organization-access.js';
import { authenticatePartner,reauthorizePartner,organizationAdmin,strictBody,type PartnerActor } from '../platform/organizations.js';
import { textField } from '../platform/tenants.js';
import { newId } from '../ids.js';
import { mappingInput } from './contracts.js';
export type SiteRole='ADMIN'|'IMPORTER'|'REVIEWER'|'READ_ONLY';
export interface EnterpriseActor {userId:string;requestId:string;partner?:PartnerActor;}
export interface Site {id:string;organization_id:string;name:string;mode:'SYNTHETIC'|'HISTORICAL';retention_days:number;fulfillment_mode:string;approval_reference:string|null;}
export function requireEnterpriseFeature(){if(process.env.PACKPROOF_ENTERPRISE_ENABLED!=='true')throw new DomainError('ENTERPRISE_DISABLED','Enterprise pilot access has not been enabled',503);}
export function absent(){return new DomainError('ENTERPRISE_RESOURCE_NOT_FOUND','Enterprise resource not found or access unavailable',404);}
export async function authenticateEnterprise(db:Database,clock:Clock,auth:AuthenticationAdapter,headers:Record<string,unknown>,requestId:string):Promise<EnterpriseActor>{
 requireEnterpriseFeature();const token=String(headers.authorization??'');
 if(/^Bearer pp_org_/.test(token)){
  const p=await authenticatePartner(db,clock,token,typeof headers['packproof-merchant-id']==='string'?headers['packproof-merchant-id']:undefined,typeof headers['packproof-delegation-id']==='string'?headers['packproof-delegation-id']:undefined,requestId);
  if(p.partnerOrganizationId||p.delegationGrantId)throw new DomainError('ENTERPRISE_DIRECT_GRANT_REQUIRED','Pilot ingestion requires a direct merchant source grant',403);
  await reauthorizePartner(db,clock,p,'enterprise:ingest');return {userId:p.actorUserId,requestId,partner:p};
 }
 const identity=await auth.authenticate(headers as Parameters<AuthenticationAdapter['authenticate']>[0]);await requireHumanActor(db,identity.userId);await requireActiveAccount(db,identity.userId);return {userId:identity.userId,requestId};
}
export async function requireSite(db:Database,clock:Clock,a:EnterpriseActor,siteId:string,roles:SiteRole[]=['ADMIN','IMPORTER','REVIEWER','READ_ONLY'],sourceId?:string):Promise<Site>{
 requireEnterpriseFeature();await assertPolicyAccessSafe(db);await requireActiveAccount(db,a.userId);
 const site=(await db.query<Site>(`SELECT s.* FROM enterprise_sites s JOIN platform_organizations o ON o.id=s.organization_id WHERE s.id=$1 AND o.kind='MERCHANT' AND o.enabled=true FOR SHARE OF o`,[siteId])).rows[0];if(!site)throw absent();
 if(site.mode==='HISTORICAL'&&process.env.PACKPROOF_ENTERPRISE_HISTORICAL_ENABLED!=='true')throw new DomainError('HISTORICAL_IMPORT_DISABLED','Historical pilot access requires the operational data approval gate',403);
 if(a.partner){
  if(!sourceId||a.partner.merchantId!==site.organization_id||!roles.includes('IMPORTER'))throw absent();await reauthorizePartner(db,clock,a.partner,'enterprise:ingest');
  const g=await db.query(`SELECT 1 FROM enterprise_source_grants g JOIN enterprise_sources s ON s.id=g.source_id WHERE g.source_id=$1 AND s.site_id=$2 AND g.principal_id=$3 AND g.revoked_at IS NULL AND g.expires_at>$4 FOR SHARE OF g`,[sourceId,siteId,a.partner.principalId,clock.now().toISOString()]);if(!g.rows[0])throw absent();return site;
 }
 await requireHumanActor(db,a.userId);
 const member=(await db.query<{role:SiteRole}>(`SELECT sm.role FROM enterprise_site_members sm JOIN platform_memberships m ON m.organization_id=$3 AND m.user_id=sm.user_id WHERE sm.site_id=$1 AND sm.user_id=$2 AND sm.revoked_at IS NULL AND m.revoked_at IS NULL FOR SHARE OF sm,m`,[siteId,a.userId,site.organization_id])).rows[0];
 if(!member||!roles.includes(member.role))throw absent();return site;
}
export async function audit(db:Database,clock:Clock,a:EnterpriseActor,siteId:string,operation:string,resourceId?:string,details:unknown={}){
 await db.query('INSERT INTO enterprise_audit(id,site_id,actor_user_id,principal_id,request_id,operation,resource_id,details,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',[newId('ent_audit'),siteId,a.userId,a.partner?.principalId??null,a.requestId,operation,resourceId??null,JSON.stringify(details),clock.now().toISOString()]);
}
export async function listSites(db:Database,clock:Clock,a:EnterpriseActor){
 if(a.partner)throw absent();await requireHumanActor(db,a.userId);await requireActiveAccount(db,a.userId);await assertPolicyAccessSafe(db);
 const sites=(await db.query<Site&{role:SiteRole}>(`SELECT s.*,sm.role FROM enterprise_sites s JOIN enterprise_site_members sm ON sm.site_id=s.id JOIN platform_memberships m ON m.organization_id=s.organization_id AND m.user_id=sm.user_id JOIN platform_organizations o ON o.id=s.organization_id WHERE sm.user_id=$1 AND sm.revoked_at IS NULL AND m.revoked_at IS NULL AND o.enabled=true ORDER BY s.name,s.id`,[a.userId])).rows;
 return {sites:sites.filter(s=>s.mode==='SYNTHETIC'||process.env.PACKPROOF_ENTERPRISE_HISTORICAL_ENABLED==='true')};
}
export async function createSite(db:Database,clock:Clock,a:EnterpriseActor,input:unknown){
 if(a.partner)throw absent();await requireHumanActor(db,a.userId);const b=strictBody(input,['organizationId','name','mode','fulfillmentMode','retentionDays','approvalReference']);
 const organizationId=textField(b.organizationId,'organizationId'),org=await organizationAdmin(db,a.userId,organizationId);if(!org.enabled||org.kind!=='MERCHANT')throw absent();
 const mode=b.mode??'SYNTHETIC';if(!['SYNTHETIC','HISTORICAL'].includes(String(mode)))throw new DomainError('INVALID_REQUEST','Choose SYNTHETIC or HISTORICAL',400);
 if(mode==='HISTORICAL'&&process.env.PACKPROOF_ENTERPRISE_HISTORICAL_ENABLED!=='true')throw new DomainError('HISTORICAL_IMPORT_DISABLED','Site and IT/data-owner approval must be recorded before enabling historical records',403);
 const approval=mode==='HISTORICAL'?textField(b.approvalReference,'approvalReference',500):null;
 if(!['PICKUP','LOCAL_DELIVERY','CARRIER','TRANSFER'].includes(String(b.fulfillmentMode)))throw new DomainError('INVALID_REQUEST','Choose one fulfillment mode',400);
 if(!Number.isSafeInteger(b.retentionDays)||Number(b.retentionDays)<1||Number(b.retentionDays)>3650)throw new DomainError('INVALID_REQUEST','Explicit retentionDays between 1 and 3650 is required',400);
 const id=newId('site');await db.query('INSERT INTO enterprise_sites(id,organization_id,name,mode,fulfillment_mode,approval_reference,retention_days,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,organizationId,textField(b.name,'name',100),mode,b.fulfillmentMode,approval,b.retentionDays,clock.now().toISOString()]);
 await db.query("INSERT INTO enterprise_site_members(site_id,user_id,role) VALUES($1,$2,'ADMIN')",[id,a.userId]);await audit(db,clock,a,id,'SITE_CREATED',id,{mode,retentionDays:b.retentionDays});return {id,mode};
}
export async function grantMember(db:Database,clock:Clock,a:EnterpriseActor,siteId:string,input:unknown){
 const site=await requireSite(db,clock,a,siteId,['ADMIN']),b=strictBody(input,['userId','role','revoked']),userId=textField(b.userId,'userId');
 if(b.revoked!==undefined&&typeof b.revoked!=='boolean')throw new DomainError('INVALID_REQUEST','revoked must be boolean',400);
 if(userId===a.userId)throw new DomainError('SELF_ACCESS_CHANGE','Use another authorized administrator for your own site permissions',409);
 if(!['ADMIN','IMPORTER','REVIEWER','READ_ONLY'].includes(String(b.role)))throw new DomainError('INVALID_REQUEST','Choose a documented site role',400);
 if(!(await db.query('SELECT 1 FROM platform_memberships WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL',[site.organization_id,userId])).rows[0])throw absent();await requireHumanActor(db,userId);
 await db.query('INSERT INTO enterprise_site_members(site_id,user_id,role,revoked_at) VALUES($1,$2,$3,$4) ON CONFLICT(site_id,user_id) DO UPDATE SET role=$3,revoked_at=$4',[siteId,userId,b.role,b.revoked?clock.now().toISOString():null]);
 await audit(db,clock,a,siteId,'SITE_MEMBERSHIP_CHANGED',userId,{role:b.role,revoked:!!b.revoked});return {userId,role:b.role,revoked:!!b.revoked};
}
export async function createSource(db:Database,clock:Clock,a:EnterpriseActor,siteId:string,input:unknown){
 await requireSite(db,clock,a,siteId,['ADMIN']);const b=strictBody(input,['name','freshnessHours']);if(!Number.isSafeInteger(b.freshnessHours)||Number(b.freshnessHours)<1||Number(b.freshnessHours)>8760)throw new DomainError('INVALID_REQUEST','Specify freshnessHours between 1 and 8760',400);
 const id=newId('source');await db.query('INSERT INTO enterprise_sources(id,site_id,name,freshness_hours,created_at) VALUES($1,$2,$3,$4,$5)',[id,siteId,textField(b.name,'name',100),b.freshnessHours,clock.now().toISOString()]);await audit(db,clock,a,siteId,'SOURCE_CREATED',id);return {id};
}
export async function requireSource(db:Database,clock:Clock,a:EnterpriseActor,sourceId:string,roles:SiteRole[]=['ADMIN','IMPORTER']){
 const s=(await db.query<{id:string;site_id:string}>('SELECT id,site_id FROM enterprise_sources WHERE id=$1',[sourceId])).rows[0];if(!s)throw absent();const site=await requireSite(db,clock,a,s.site_id,roles,sourceId);return {...s,site};
}
export async function addMapping(db:Database,clock:Clock,a:EnterpriseActor,sourceId:string,input:unknown){
 const s=await requireSource(db,clock,a,sourceId,['ADMIN']),b=strictBody(input,['mapping','approvalReference']),mapping=mappingInput(b.mapping),id=newId('mapping');
 for(const namespace of [mapping.orderNamespaceSourceId,mapping.fulfillmentNamespaceSourceId])if(namespace&&!(await db.query('SELECT 1 FROM enterprise_sources WHERE id=$1 AND site_id=$2',[namespace,s.site_id])).rows[0])throw new DomainError('INVALID_SOURCE_NAMESPACE','Namespace mappings must reference an approved source in this same site',400);
 await db.query('INSERT INTO enterprise_mappings(id,source_id,version,dictionary,approved_by,approval_reference,created_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)',[id,sourceId,mapping.version,JSON.stringify(mapping),a.userId,textField(b.approvalReference,'approvalReference',500),clock.now().toISOString()]);await audit(db,clock,a,s.site_id,'MAPPING_APPROVED',id,{version:mapping.version});return {id,mapping};
}
export async function grantSource(db:Database,clock:Clock,a:EnterpriseActor,sourceId:string,input:unknown){
 const s=await requireSource(db,clock,a,sourceId,['ADMIN']),b=strictBody(input,['principalId','expiresAt','revoked']),principalId=textField(b.principalId,'principalId');
 if(!(await db.query('SELECT 1 FROM platform_principals WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL',[principalId,s.site.organization_id])).rows[0])throw absent();
 const expiry=typeof b.expiresAt==='string'?Date.parse(b.expiresAt):NaN;if(!Number.isFinite(expiry)||expiry<=clock.now().getTime()||expiry>clock.now().getTime()+90*86400000)throw new DomainError('INVALID_EXPIRY','Source grants expire within 90 days',400);
 if(b.revoked!==undefined&&typeof b.revoked!=='boolean')throw new DomainError('INVALID_REQUEST','revoked must be boolean',400);
 await db.query('INSERT INTO enterprise_source_grants(source_id,principal_id,expires_at,revoked_at) VALUES($1,$2,$3,$4) ON CONFLICT(source_id,principal_id) DO UPDATE SET expires_at=$3,revoked_at=$4',[sourceId,principalId,new Date(expiry).toISOString(),b.revoked===true?clock.now().toISOString():null]);await audit(db,clock,a,s.site_id,'SOURCE_GRANT_CHANGED',principalId,{revoked:b.revoked===true});return {principalId,expiresAt:new Date(expiry).toISOString()};
}
