import express,{type Request,type Response,type NextFunction} from 'express';
import type {AppDependencies} from '../app.js';
import type {Database} from '../db/database.js';
import {DomainError} from '../domain/errors.js';
import {newId} from '../ids.js';
import {sha256Hex} from '../hash.js';
import {canonicalize} from '../canonical.js';
import {textField} from './tenants.js';
import {requirePartnerFeature,partnerProblem} from './partner-router.js';
import {protectWebhookResponse,webhookConfigFromEnv} from './webhooks.js';
import {requireDeveloperAccess} from '../auth/developer-access.js';
import {organizationAdmin,createOrganization,setOrganizationEntitlement,addOrganizationMember,revokeOrganizationMember,
 createServicePrincipal,revokeServicePrincipal,issuePartnerCredential,revokePartnerCredential,createDelegation,revokeDelegation,createIntegrationAccount} from './organizations.js';

export function createOrganizationRouter(deps:AppDependencies){
 const router=express.Router(),config=deps.webhookConfig??webhookConfigFromEnv();
 const run=(fn:(r:Request,s:Response)=>Promise<void>)=>(r:Request,s:Response,n:NextFunction)=>{void fn(r,s).catch(n);};
 async function identity(req:Request,mutating:boolean){
  requirePartnerFeature();
  const auth=await deps.auth.authenticate(req.headers);
  if(mutating&&!(deps.devAuth&&deps.testFixtures)){
   const age=deps.clock.now().getTime()/1000-(auth.authenticatedAt??0);
   if(age<0||age>300)throw new DomainError('RECENT_AUTHENTICATION_REQUIRED','Sign in again before changing organization access',401);
  }
  return auth.userId;
 }
 router.use((_r,s,n)=>{s.setHeader('Cache-Control','private, no-store');n();});
 router.get('/',run(async(r,s)=>{
  const user=await identity(r,false);
  s.json({organizations:(await deps.db.query(`SELECT o.id,o.kind,o.name,o.environment,o.enabled,m.role FROM platform_organizations o
   JOIN platform_memberships m ON m.organization_id=o.id WHERE m.user_id=$1 AND m.revoked_at IS NULL ORDER BY o.id`,[user])).rows});
 }));
 function command(path:string,fn:(db:Database,user:string,req:Request,requestId:string)=>Promise<unknown>,bootstrap=false,sensitive=false){
  router.post(path,run(async(r,s)=>{
   const user=await identity(r,true),requestId=s.locals.operationId??newId('req');
   const authorize=async(db:Database)=>{if(bootstrap)await requireDeveloperAccess(db,user);else await organizationAdmin(db,user,r.params.organizationId);};
   await authorize(deps.db);
   const keyHash=sha256Hex(textField(r.header('Idempotency-Key'),'Idempotency-Key')),requestHash=sha256Hex(canonicalize(r.body??{})),operation=`POST ${r.path}`;
   if(sensitive&&Buffer.from(config.encryptionKey,'base64').length!==32)throw new DomainError('SECRET_RESPONSE_UNAVAILABLE','Response encryption is not configured',503);
   const protection=sensitive?protectWebhookResponse(`organization:${user}:${operation}:${keyHash}`,config):null;
   const value=await deps.db.transaction(async tx=>{
    await authorize(tx);
    await tx.query('INSERT INTO platform_command_results(actor_user_id,operation,key_hash,request_hash,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[user,operation,keyHash,requestHash,deps.clock.now().toISOString()]);
    const row=(await tx.query<{request_hash:string;response:unknown}>('SELECT request_hash,response FROM platform_command_results WHERE actor_user_id=$1 AND operation=$2 AND key_hash=$3 FOR UPDATE',[user,operation,keyHash])).rows[0];
    if(row.request_hash!==requestHash)throw new DomainError('IDEMPOTENCY_CONFLICT','This key was used with different input',409);
    if(row.response!==null){s.setHeader('Idempotency-Replayed','true');return protection?protection.open(row.response):row.response;}
    const result=await fn(tx,user,r,requestId);
    await tx.query('UPDATE platform_command_results SET response=$4::jsonb WHERE actor_user_id=$1 AND operation=$2 AND key_hash=$3',[user,operation,keyHash,JSON.stringify(protection?protection.seal(result):result)]);
    s.setHeader('Idempotency-Replayed','false');return result;
   });
   await authorize(deps.db);s.status(200).json(value);
  }));
 }
 command('/',(db,u,r,id)=>createOrganization(db,deps.clock,u,r.body,id),true);
 command('/:organizationId/entitlement',(db,u,r,id)=>setOrganizationEntitlement(db,deps.clock,u,r.params.organizationId,r.body,id),true);
 command('/:organizationId/memberships',(db,u,r,id)=>addOrganizationMember(db,deps.clock,u,r.params.organizationId,r.body,id));
 command('/:organizationId/memberships/:membershipId/revoke',(db,u,r,id)=>revokeOrganizationMember(db,deps.clock,u,r.params.organizationId,r.params.membershipId,id));
 command('/:organizationId/service-principals',(db,u,r,id)=>createServicePrincipal(db,deps.clock,u,r.params.organizationId,r.body,id));
 command('/:organizationId/service-principals/:principalId/revoke',(db,u,r,id)=>revokeServicePrincipal(db,deps.clock,u,r.params.organizationId,r.params.principalId,id));
 command('/:organizationId/service-principals/:principalId/credentials',(db,u,r,id)=>issuePartnerCredential(db,deps.clock,u,r.params.organizationId,r.params.principalId,r.body,id),false,true);
 command('/:organizationId/credentials/:credentialId/revoke',(db,u,r,id)=>revokePartnerCredential(db,deps.clock,u,r.params.organizationId,r.params.credentialId,id));
 command('/:organizationId/delegations',(db,u,r,id)=>createDelegation(db,deps.clock,u,r.params.organizationId,r.body,id));
 command('/:organizationId/delegations/:grantId/revoke',(db,u,r,id)=>revokeDelegation(db,deps.clock,u,r.params.organizationId,r.params.grantId,id));
 command('/:organizationId/integration-accounts',(db,u,r,id)=>createIntegrationAccount(db,deps.clock,u,r.params.organizationId,r.body,id));
 router.get('/:organizationId/administration',run(async(r,s)=>{
  const user=await identity(r,false);await organizationAdmin(deps.db,user,r.params.organizationId);
  const id=r.params.organizationId;
  const memberships=(await deps.db.query('SELECT id,user_id AS "userId",role,revoked_at AS "revokedAt" FROM platform_memberships WHERE organization_id=$1 ORDER BY id',[id])).rows;
  const principals=(await deps.db.query('SELECT id,name,revoked_at AS "revokedAt" FROM platform_principals WHERE organization_id=$1 ORDER BY id',[id])).rows;
  const credentials=(await deps.db.query('SELECT c.id,c.principal_id AS "principalId",c.prefix,c.scopes,c.expires_at AS "expiresAt",c.last_used_at AS "lastUsedAt",c.revoked_at AS "revokedAt" FROM platform_credentials c JOIN platform_principals p ON p.id=c.principal_id WHERE p.organization_id=$1 ORDER BY c.id',[id])).rows;
  const delegations=(await deps.db.query('SELECT id,partner_id AS "partnerId",scopes,operator_ids AS "operatorUserIds",expires_at AS "expiresAt",revoked_at AS "revokedAt" FROM platform_delegations WHERE merchant_id=$1 ORDER BY id',[id])).rows;
  s.json({memberships,principals,credentials,delegations});
 }));
 router.get('/:organizationId/audit-events',run(async(r,s)=>{
  const user=await identity(r,false);await organizationAdmin(deps.db,user,r.params.organizationId);
  s.json({events:(await deps.db.query('SELECT * FROM platform_action_audit WHERE merchant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',[r.params.organizationId])).rows});
 }));
 router.use(partnerProblem);
 return router;
}
