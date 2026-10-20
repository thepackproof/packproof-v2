import { randomBytes } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { DomainError } from '../domain/errors.js';
import { requireActiveAccount } from '../domain/account-access.js';
import { assertPolicyAccessSafe } from '../domain/policy-recovery.js';
import { requireDeveloperAccess } from '../auth/developer-access.js';
import { insertUser } from '../domain/users.js';
import { newId } from '../ids.js';
import { sha256Hex } from '../hash.js';
import { record, textField } from './tenants.js';

export const PARTNER_SCOPES=['proofs:read','proofs:write','capture:request','exports:read','events:read','webhooks:manage'] as const;
export type PartnerScope=typeof PARTNER_SCOPES[number];
export const AUTHORIZATION_POLICY='packproof.authorization/v1';
export interface PartnerActor {
 principalId:string; credentialId:string; actorUserId:string; principalOrganizationId:string;
 merchantId:string; partnerOrganizationId:string|null; delegationGrantId:string|null;
 tenantId:string; environment:'sandbox'|'live'; scopes:PartnerScope[]; requestId:string;
}
export function strictBody(input:unknown,allowed:string[]) {
 const body=record(input);
 if(Object.keys(body).some(k=>!allowed.includes(k)))throw new DomainError('INVALID_REQUEST','Only documented fields are accepted',400);
 return body;
}
function scopes(input:unknown):PartnerScope[]{
 if(!Array.isArray(input)||!input.length||input.some(s=>!PARTNER_SCOPES.includes(s)))throw new DomainError('INVALID_SCOPES','Choose documented partner scopes',400);
 return [...new Set(input)] as PartnerScope[];
}
function expiration(value:unknown,clock:Clock,maxDays=90){
 const time=typeof value==='string'?Date.parse(value):NaN;
 if(!Number.isFinite(time)||time<=clock.now().getTime()||time>clock.now().getTime()+maxDays*86400000)
   throw new DomainError('INVALID_EXPIRY',`expiresAt must be in the next ${maxDays} days`,400);
 return new Date(time).toISOString();
}
export async function organizationAdmin(db:Database,userId:string,organizationId:string){
 await assertPolicyAccessSafe(db);
 await requireActiveAccount(db,userId);
 const row=(await db.query<{id:string;kind:'MERCHANT'|'PARTNER';environment:'sandbox'|'live';tenant_id:string|null;enabled:boolean}>(`
  SELECT o.* FROM platform_organizations o JOIN platform_memberships m ON m.organization_id=o.id
  WHERE o.id=$1 AND m.user_id=$2 AND m.revoked_at IS NULL AND m.role IN ('OWNER','ADMIN') FOR SHARE OF m`,[organizationId,userId])).rows[0];
 if(!row)throw new DomainError('ORGANIZATION_NOT_FOUND','Organization not found',404);return row;
}
export async function auditOrganization(db:Database,clock:Clock,input:{userId?:string;actor?:PartnerActor;merchantId?:string;requestId:string;operation:string;resourceId?:string}){
 const a=input.actor;
 await db.query(`INSERT INTO platform_action_audit(id,merchant_id,actor_user_id,principal_id,credential_id,delegation_id,request_id,operation,resource_id,policy_version,created_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[newId('org_audit'),a?.merchantId??input.merchantId??null,input.userId??null,a?.principalId??null,a?.credentialId??null,a?.delegationGrantId??null,input.requestId,input.operation,input.resourceId??null,AUTHORIZATION_POLICY,clock.now().toISOString()]);
}
/** Bootstrap is restricted to the existing verified developer entitlement. New
 * merchant registration does not grant live API access. Enabling is separate. */
export async function createOrganization(db:Database,clock:Clock,userId:string,input:unknown,requestId:string){
 await requireDeveloperAccess(db,userId);
 const b=strictBody(input,['name','kind','environment','ownerUserId']);
 const name=textField(b.name,'name',100),kind=b.kind,environment=b.environment??'sandbox';
 if(!['MERCHANT','PARTNER'].includes(String(kind))||!['sandbox','live'].includes(String(environment)))throw new DomainError('INVALID_REQUEST','Choose a merchant or partner and sandbox or live environment',400);
 const ownerUserId=b.ownerUserId==null?userId:textField(b.ownerUserId,'ownerUserId');await requireActiveAccount(db,ownerUserId);
 return db.transaction(async tx=>{
  const id=newId('org'),tenantId=kind==='MERCHANT'?newId('ten'):null,now=clock.now().toISOString();
  if(tenantId)await tx.query('INSERT INTO api_tenants(id,owner_user_id,name,environment,created_at) VALUES($1,$2,$3,$4,$5)',[tenantId,ownerUserId,`organization:${id}`,environment,now]);
  await tx.query('INSERT INTO platform_organizations(id,kind,name,owner_user_id,environment,tenant_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,kind,name,ownerUserId,environment,tenantId,now]);
  await tx.query("INSERT INTO platform_memberships(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'OWNER',$4)",[newId('member'),id,ownerUserId,now]);
  await auditOrganization(tx,clock,{userId,merchantId:id,requestId,operation:'ORGANIZATION_CREATED',resourceId:id});
  return {id,kind,name,environment,enabled:false};
 });
}
export async function setOrganizationEntitlement(db:Database,clock:Clock,userId:string,id:string,input:unknown,requestId:string){
 await requireDeveloperAccess(db,userId);const b=strictBody(input,['enabled']);
 if(typeof b.enabled!=='boolean')throw new DomainError('INVALID_REQUEST','enabled must be a boolean',400);
 return db.transaction(async tx=>{
  const result=await tx.query('UPDATE platform_organizations SET enabled=$2 WHERE id=$1 RETURNING id,enabled',[id,b.enabled]);
  if(!result.rows[0])throw new DomainError('ORGANIZATION_NOT_FOUND','Organization not found',404);
  await auditOrganization(tx,clock,{userId,merchantId:id,requestId,operation:'ORGANIZATION_ENTITLEMENT_CHANGED',resourceId:id});return result.rows[0];
 });
}
export async function addOrganizationMember(db:Database,clock:Clock,userId:string,id:string,input:unknown,requestId:string){
 const b=strictBody(input,['userId','role']);const memberUser=textField(b.userId,'userId');
 if(!['ADMIN','OPERATOR','REVIEWER'].includes(String(b.role)))throw new DomainError('INVALID_REQUEST','Choose ADMIN, OPERATOR or REVIEWER',400);
 await requireActiveAccount(db,memberUser);
 return db.transaction(async tx=>{
  await organizationAdmin(tx,userId,id);
  const membershipId=newId('member');
  const result=await tx.query(`INSERT INTO platform_memberships(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(organization_id,user_id) DO NOTHING RETURNING id,user_id AS "userId",role`,[membershipId,id,memberUser,b.role,clock.now().toISOString()]);
  if(!result.rows[0])throw new DomainError('MEMBERSHIP_EXISTS','This membership already exists; revoked identities are not silently reactivated',409);
  await auditOrganization(tx,clock,{userId,merchantId:id,requestId,operation:'MEMBERSHIP_CREATED',resourceId:membershipId});return result.rows[0];
 });
}
export async function revokeOrganizationMember(db:Database,clock:Clock,userId:string,id:string,membershipId:string,requestId:string){
 return db.transaction(async tx=>{
  await organizationAdmin(tx,userId,id);
  const r=await tx.query("UPDATE platform_memberships SET revoked_at=COALESCE(revoked_at,$3) WHERE id=$1 AND organization_id=$2 AND role<>'OWNER' RETURNING id",[membershipId,id,clock.now().toISOString()]);
  if(!r.rows[0])throw new DomainError('MEMBERSHIP_NOT_FOUND','Revocable membership not found',404);
  await auditOrganization(tx,clock,{userId,merchantId:id,requestId,operation:'MEMBERSHIP_REVOKED',resourceId:membershipId});return {id:membershipId,revoked:true};
 });
}
export async function createServicePrincipal(db:Database,clock:Clock,userId:string,id:string,input:unknown,requestId:string){
 const b=strictBody(input,['name']);const name=textField(b.name,'name',100);
 return db.transaction(async tx=>{
  await organizationAdmin(tx,userId,id);const principalId=newId('principal');
  // A distinct non-login actor preserves actual machine attribution in the
  // existing core's user-id foreign keys. It never receives a human auth identity.
  const actorUserId=await insertUser(tx,clock,newId('service_actor'));
  await tx.query('INSERT INTO platform_principals(id,organization_id,actor_user_id,name,created_at) VALUES($1,$2,$3,$4,$5)',[principalId,id,actorUserId,name,clock.now().toISOString()]);
  await auditOrganization(tx,clock,{userId,merchantId:id,requestId,operation:'SERVICE_PRINCIPAL_CREATED',resourceId:principalId});return {id:principalId,name,principalType:'SERVICE'};
 });
}
export async function issuePartnerCredential(db:Database,clock:Clock,userId:string,id:string,principalId:string,input:unknown,requestId:string){
 const b=strictBody(input,['scopes','expiresAt']);const allowed=scopes(b.scopes),expiresAt=expiration(b.expiresAt,clock);
 return db.transaction(async tx=>{
  const org=await organizationAdmin(tx,userId,id);
  const p=await tx.query('SELECT id FROM platform_principals WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL',[principalId,id]);
  if(!p.rows[0])throw new DomainError('PRINCIPAL_NOT_FOUND','Principal not found',404);
  const credentialId=newId('credential'),token=`pp_org_${org.environment}_${randomBytes(32).toString('base64url')}`,prefix=token.slice(0,22);
  await tx.query('INSERT INTO platform_credentials(id,principal_id,token_hash,prefix,scopes,created_at,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)',[credentialId,principalId,sha256Hex(token),prefix,JSON.stringify(allowed),clock.now().toISOString(),expiresAt]);
  await auditOrganization(tx,clock,{userId,merchantId:id,requestId,operation:'CREDENTIAL_ISSUED',resourceId:credentialId});return {id:credentialId,prefix,token,scopes:allowed,expiresAt};
 });
}
export async function revokeServicePrincipal(db:Database,clock:Clock,userId:string,id:string,principalId:string,requestId:string){
 return db.transaction(async tx=>{
  await organizationAdmin(tx,userId,id);
  const r=await tx.query('UPDATE platform_principals SET revoked_at=COALESCE(revoked_at,$3) WHERE id=$1 AND organization_id=$2 RETURNING id',[principalId,id,clock.now().toISOString()]);
  if(!r.rows[0])throw new DomainError('PRINCIPAL_NOT_FOUND','Principal not found',404);
  await auditOrganization(tx,clock,{userId,merchantId:id,requestId,operation:'SERVICE_PRINCIPAL_REVOKED',resourceId:principalId});return {id:principalId,revoked:true};
 });
}
export async function revokePartnerCredential(db:Database,clock:Clock,userId:string,id:string,credentialId:string,requestId:string){
 return db.transaction(async tx=>{
  await organizationAdmin(tx,userId,id);
  const r=await tx.query(`UPDATE platform_credentials c SET revoked_at=COALESCE(c.revoked_at,$3) FROM platform_principals p
    WHERE c.id=$1 AND c.principal_id=p.id AND p.organization_id=$2 RETURNING c.id`,[credentialId,id,clock.now().toISOString()]);
  if(!r.rows[0])throw new DomainError('CREDENTIAL_NOT_FOUND','Credential not found',404);
  await auditOrganization(tx,clock,{userId,merchantId:id,requestId,operation:'CREDENTIAL_REVOKED',resourceId:credentialId});return {id:credentialId,revoked:true};
 });
}
export async function createDelegation(db:Database,clock:Clock,userId:string,id:string,input:unknown,requestId:string){
 const b=strictBody(input,['partnerOrganizationId','scopes','operatorUserIds','expiresAt']);
 const partnerId=textField(b.partnerOrganizationId,'partnerOrganizationId'),allowed=scopes(b.scopes),expiresAt=expiration(b.expiresAt,clock);
 if(!Array.isArray(b.operatorUserIds)||b.operatorUserIds.length>100||b.operatorUserIds.some(x=>typeof x!=='string'))throw new DomainError('INVALID_REQUEST','Supply up to 100 explicitly authorized operator user IDs',400);
 const operators=[...new Set(b.operatorUserIds as string[])];
 return db.transaction(async tx=>{
  const merchant=await organizationAdmin(tx,userId,id);
  const partner=(await tx.query<{environment:string}>("SELECT environment FROM platform_organizations WHERE id=$1 AND kind='PARTNER' AND enabled=true",[partnerId])).rows[0];
  if(merchant.kind!=='MERCHANT'||!merchant.enabled||!partner||partner.environment!==merchant.environment)throw new DomainError('PARTNER_UNAVAILABLE','Choose enabled organizations in the same environment',400);
  for(const operator of operators){
   const m=await tx.query("SELECT 1 FROM platform_memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id IN ($1,$2) AND m.user_id=$3 AND m.role IN ('OWNER','ADMIN','OPERATOR') AND m.revoked_at IS NULL AND u.status='ACTIVE'",[id,partnerId,operator]);
   if(!m.rows[0])throw new DomainError('OPERATOR_NOT_AUTHORIZED','Each operator must have an active permitted membership',400);
  }
  const grantId=newId('grant');
  await tx.query('INSERT INTO platform_delegations(id,merchant_id,partner_id,environment,scopes,operator_ids,issued_by,created_at,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)',[grantId,id,partnerId,merchant.environment,JSON.stringify(allowed),JSON.stringify(operators),userId,clock.now().toISOString(),expiresAt]);
  await auditOrganization(tx,clock,{userId,merchantId:id,requestId,operation:'DELEGATION_CREATED',resourceId:grantId});return {id:grantId,merchantId:id,partnerOrganizationId:partnerId,scopes:allowed,operatorUserIds:operators,expiresAt};
 });
}
export async function revokeDelegation(db:Database,clock:Clock,userId:string,id:string,grantId:string,requestId:string){
 return db.transaction(async tx=>{
  await organizationAdmin(tx,userId,id);
  const r=await tx.query('UPDATE platform_delegations SET revoked_at=COALESCE(revoked_at,$3) WHERE id=$1 AND merchant_id=$2 RETURNING id',[grantId,id,clock.now().toISOString()]);
  if(!r.rows[0])throw new DomainError('GRANT_NOT_FOUND','Grant not found',404);
  await auditOrganization(tx,clock,{userId,merchantId:id,requestId,operation:'DELEGATION_REVOKED',resourceId:grantId});return {id:grantId,revoked:true};
 });
}
export async function createIntegrationAccount(db:Database,clock:Clock,userId:string,id:string,input:unknown,requestId:string){
 const b=strictBody(input,['provider','externalAccountId']);const provider=textField(b.provider,'provider',80),externalId=textField(b.externalAccountId,'externalAccountId',200);
 // This is an identity namespace, not a claim that a provider connection exists.
 return db.transaction(async tx=>{
  const org=await organizationAdmin(tx,userId,id);if(org.kind!=='MERCHANT')throw new DomainError('MERCHANT_REQUIRED','Integration accounts belong to merchants',400);
  const accountId=newId('integration');
  await tx.query('INSERT INTO platform_integration_accounts(id,merchant_id,environment,provider,external_account_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',[accountId,id,org.environment,provider,externalId,clock.now().toISOString()]);
  await auditOrganization(tx,clock,{userId,merchantId:id,requestId,operation:'INTEGRATION_NAMESPACE_CREATED',resourceId:accountId});return {id:accountId,provider,environment:org.environment,connectionStatus:'NAMESPACE_ONLY'};
 });
}
export async function authenticatePartner(db:Database,clock:Clock,authorization:string|undefined,merchantId:string|undefined,grantId:string|undefined,requestId:string):Promise<PartnerActor>{
 await assertPolicyAccessSafe(db);
 const token=authorization?.match(/^Bearer (pp_org_(?:sandbox|live)_[A-Za-z0-9_-]{43})$/)?.[1];
 if(!token)throw new DomainError('UNAUTHENTICATED','An organization service credential is required',401);
 const credential=(await db.query<{id:string;principal_id:string;actor_user_id:string;organization_id:string;environment:'sandbox'|'live';kind:string;scopes:PartnerScope[]}>(`
  SELECT c.id,c.principal_id,p.actor_user_id,p.organization_id,o.environment,o.kind,c.scopes FROM platform_credentials c
  JOIN platform_principals p ON p.id=c.principal_id JOIN platform_organizations o ON o.id=p.organization_id JOIN users u ON u.id=p.actor_user_id
  WHERE c.token_hash=$1 AND c.revoked_at IS NULL AND c.expires_at>$2 AND p.revoked_at IS NULL AND o.enabled=true AND u.status='ACTIVE'`,[sha256Hex(token),clock.now().toISOString()])).rows[0];
 if(!credential)throw new DomainError('UNAUTHENTICATED','Invalid, expired or revoked organization credential',401);
 const effectiveMerchant=merchantId??(credential.kind==='MERCHANT'?credential.organization_id:null);
 if(!effectiveMerchant)throw new DomainError('MERCHANT_REQUIRED','Select the authorized merchant with PackProof-Merchant-Id',400);
 const merchant=(await db.query<{tenant_id:string}>("SELECT tenant_id FROM platform_organizations WHERE id=$1 AND kind='MERCHANT' AND environment=$2 AND enabled=true",[effectiveMerchant,credential.environment])).rows[0];
 if(!merchant)throw new DomainError('MERCHANT_NOT_FOUND','Authorized merchant not found',404);
 let effectiveScopes=credential.scopes,delegationGrantId:string|null=null;
 if(credential.organization_id!==effectiveMerchant){
  const grant=(await db.query<{id:string;scopes:PartnerScope[]}>(`SELECT id,scopes FROM platform_delegations WHERE id=$1 AND merchant_id=$2 AND partner_id=$3 AND environment=$4 AND revoked_at IS NULL AND expires_at>$5`,[grantId??'',effectiveMerchant,credential.organization_id,credential.environment,clock.now().toISOString()])).rows[0];
  if(credential.kind!=='PARTNER'||!grant)throw new DomainError('MERCHANT_NOT_FOUND','Authorized merchant not found',404);
  delegationGrantId=grant.id;effectiveScopes=effectiveScopes.filter(s=>grant.scopes.includes(s));
 }else if(grantId)throw new DomainError('INVALID_GRANT','Direct merchant credentials do not use partner grants',400);
 await db.query('UPDATE platform_credentials SET last_used_at=$2 WHERE id=$1',[credential.id,clock.now().toISOString()]);
 return {principalId:credential.principal_id,credentialId:credential.id,actorUserId:credential.actor_user_id,principalOrganizationId:credential.organization_id,merchantId:effectiveMerchant,partnerOrganizationId:delegationGrantId?credential.organization_id:null,delegationGrantId,tenantId:merchant.tenant_id,environment:credential.environment,scopes:effectiveScopes,requestId};
}
export async function reauthorizePartner(db:Database,clock:Clock,actor:PartnerActor,scope:PartnerScope){
 await assertPolicyAccessSafe(db);
 const row=(await db.query<{scopes:PartnerScope[]}>(`SELECT c.scopes FROM platform_credentials c JOIN platform_principals p ON p.id=c.principal_id
  JOIN platform_organizations o ON o.id=p.organization_id JOIN users u ON u.id=p.actor_user_id
  WHERE c.id=$1 AND p.id=$2 AND p.organization_id=$3 AND c.revoked_at IS NULL AND c.expires_at>$4
  AND p.revoked_at IS NULL AND o.enabled=true AND u.status='ACTIVE' FOR SHARE OF c,p,o,u`,[actor.credentialId,actor.principalId,actor.principalOrganizationId,clock.now().toISOString()])).rows[0];
 const merchant=(await db.query('SELECT 1 FROM platform_organizations WHERE id=$1 AND environment=$2 AND tenant_id=$3 AND enabled=true FOR SHARE',[actor.merchantId,actor.environment,actor.tenantId])).rows[0];
 if(!row||!merchant||!row.scopes.includes(scope)||!actor.scopes.includes(scope))throw new DomainError('INSUFFICIENT_SCOPE','Current authorization does not permit this operation',403);
 if(actor.delegationGrantId){
  const grant=await db.query(`SELECT 1 FROM platform_delegations WHERE id=$1 AND merchant_id=$2 AND partner_id=$3 AND environment=$4 AND revoked_at IS NULL AND expires_at>$5 AND scopes ? $6 FOR SHARE`,[actor.delegationGrantId,actor.merchantId,actor.principalOrganizationId,actor.environment,clock.now().toISOString(),scope]);
  if(!grant.rows[0])throw new DomainError('INSUFFICIENT_SCOPE','Current authorization does not permit this operation',403);
 }else if(actor.principalOrganizationId!==actor.merchantId)throw new DomainError('INSUFFICIENT_SCOPE','Merchant delegation is required',403);
}
export async function authorizePartnerProof(db:Database,clock:Clock,actor:PartnerActor,proofId:string,scope:PartnerScope){
 await reauthorizePartner(db,clock,actor,scope);
 const row=(await db.query<{operator_user_id:string;operator_membership_id:string}>(`SELECT m.user_id AS operator_user_id,p.operator_membership_id
  FROM platform_proof_ownership p JOIN platform_memberships m ON m.id=p.operator_membership_id
  WHERE p.proof_id=$1 AND p.merchant_id=$2 AND p.environment=$3`,[proofId,actor.merchantId,actor.environment])).rows[0];
 if(!row)throw new DomainError('PROOF_NOT_FOUND','Proof not found',404);return row;
}
