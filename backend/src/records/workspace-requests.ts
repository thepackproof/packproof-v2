import express,{type Request,type Response,type NextFunction} from 'express';
import type {AppDependencies} from '../app.js';
import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import {DomainError} from '../domain/errors.js';
import {requireActiveAccount} from '../domain/account-access.js';
import {assertPolicyAccessSafe} from '../domain/policy-recovery.js';
import {requireHumanActor} from '../platform/organization-access.js';
import {auditOrganization,strictBody} from '../platform/organizations.js';
import {newId} from '../ids.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';

function text(value:unknown,name:string,limit=100){if(typeof value!=='string'||!value.trim()||value.trim().length>limit)throw new DomainError('INVALID_WORKSPACE',`Enter ${name} using 1 to ${limit} characters`,400);return value.trim();}
export async function requestWorkspace(db:Database,clock:Clock,userId:string,input:unknown,key:unknown){
 if(process.env.PACKPROOF_WORKSPACE_SELF_SERVICE_ENABLED!=='true'||process.env.PACKPROOF_ORGANIZATIONS_ENABLED!=='true')throw new DomainError('WORKSPACE_PROVISIONING_PENDING','Workspace registration is awaiting activation. Your existing records remain available.',503);
 const b=strictBody(input,['businessName','region','timeZone','locationName','environment']);
 const businessName=text(b.businessName,'a business name'),region=text(b.region,'a region'),timeZone=text(b.timeZone,'a time zone');
 const locationName=b.locationName==null||b.locationName===''?null:text(b.locationName,'a location name');
 const environment=b.environment;
 if(environment!=='sandbox'&&environment!=='live')throw new DomainError('INVALID_ENVIRONMENT','Choose sandbox or live explicitly',400);
 try{new Intl.DateTimeFormat('en-US',{timeZone}).format();}catch{throw new DomainError('INVALID_TIME_ZONE','Choose a valid named time zone, such as America/New_York',400);}
 if(typeof key!=='string'||!key||key.length>200)throw new DomainError('IDEMPOTENCY_KEY_REQUIRED','Supply a stable Idempotency-Key for workspace registration',400);
 const hash=sha256Hex(canonicalize({businessName,region,timeZone,locationName,environment})),operation=`workspace-request:${environment}`,keyHash=sha256Hex(key);
 return db.transaction(async tx=>{
  await assertPolicyAccessSafe(tx);await requireActiveAccount(tx,userId);await requireHumanActor(tx,userId);
  if(!(await tx.query('SELECT 1 FROM user_verified_contacts WHERE user_id=$1 AND verified_at<=$2',[userId,clock.now().toISOString()])).rows[0])throw new DomainError('VERIFIED_CONTACT_REQUIRED','Verify your email address before creating a workspace',403);
  await tx.query('SELECT pg_advisory_xact_lock(1347438149,hashtext($1))',[userId]);
  const now=clock.now().toISOString();
  await tx.query('INSERT INTO platform_command_results(actor_user_id,operation,key_hash,request_hash,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[userId,operation,keyHash,hash,now]);
  const prior=(await tx.query<{request_hash:string;response:unknown}>('SELECT request_hash,response FROM platform_command_results WHERE actor_user_id=$1 AND operation=$2 AND key_hash=$3 FOR UPDATE',[userId,operation,keyHash])).rows[0];
  if(prior.request_hash!==hash)throw new DomainError('IDEMPOTENCY_CONFLICT','This request key was already used with different workspace details',409);
  if(prior.response!==null)return typeof prior.response==='string'?JSON.parse(prior.response):prior.response;
  const existing=(await tx.query<{id:string;organization_id:string}>('SELECT id,organization_id FROM record_workspace_requests WHERE actor_user_id=$1 AND environment=$2',[userId,environment])).rows[0];
  if(existing)throw new DomainError('WORKSPACE_REQUEST_EXISTS','You already have a workspace request in this environment. Continue the existing setup.',409);
  const organizationId=newId('org'),tenantId=newId('ten'),requestId=newId('workspace');
  // Registration never enables the organization. Existing developer-controlled
  // organization entitlement is still the only activation path.
  await tx.query('INSERT INTO api_tenants(id,owner_user_id,name,environment,created_at) VALUES($1,$2,$3,$4,$5)',[tenantId,userId,`organization:${organizationId}`,environment,now]);
  await tx.query("INSERT INTO platform_organizations(id,kind,name,owner_user_id,environment,tenant_id,enabled,created_at) VALUES($1,'MERCHANT',$2,$3,$4,$5,false,$6)",[organizationId,businessName,userId,environment,tenantId,now]);
  await tx.query("INSERT INTO platform_memberships(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'OWNER',$4)",[newId('member'),organizationId,userId,now]);
  await tx.query('INSERT INTO record_workspace_requests(id,actor_user_id,organization_id,environment,business_name,region,time_zone,location_name,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[requestId,userId,organizationId,environment,businessName,region,timeZone,locationName,now]);
  await auditOrganization(tx,clock,{userId,merchantId:organizationId,requestId,operation:'WORKSPACE_REGISTRATION_REQUESTED',resourceId:requestId});
  const result={requestId,organizationId,environment,state:'waiting_for_activation',businessName,region,timeZone,locationName,createdAt:now};
  await tx.query('UPDATE platform_command_results SET response=$4::jsonb WHERE actor_user_id=$1 AND operation=$2 AND key_hash=$3',[userId,operation,keyHash,JSON.stringify(result)]);
  return result;
 });
}
export function createWorkspaceRequestsRouter(deps:AppDependencies){
 const router=express.Router();
 const route=(fn:(r:Request,s:Response)=>Promise<void>)=>(r:Request,s:Response,n:NextFunction)=>void fn(r,s).catch(n);
 router.use((_r,s,n)=>{s.setHeader('Cache-Control','private, no-store');n();});
 router.get('/',route(async(r,s)=>{
  const auth=await deps.auth.authenticate(r.headers);await requireActiveAccount(deps.db,auth.userId);await assertPolicyAccessSafe(deps.db);await requireHumanActor(deps.db,auth.userId);
  const requests=(await deps.db.query(`SELECT r.id AS "requestId",r.organization_id AS "organizationId",r.environment,r.business_name AS "businessName",r.region,r.time_zone AS "timeZone",r.location_name AS "locationName",r.created_at AS "createdAt",CASE WHEN o.enabled AND $2::boolean THEN 'ready' ELSE 'waiting_for_activation' END AS state FROM record_workspace_requests r JOIN platform_organizations o ON o.id=r.organization_id JOIN platform_memberships m ON m.organization_id=o.id AND m.user_id=r.actor_user_id AND m.revoked_at IS NULL WHERE r.actor_user_id=$1 ORDER BY r.created_at DESC LIMIT 20`,[auth.userId,process.env.PACKPROOF_ORGANIZATIONS_ENABLED==='true'])).rows;
  s.json({requests});
 }));
 router.post('/',route(async(r,s)=>{
  const auth=await deps.auth.authenticate(r.headers);
  if(!(deps.devAuth&&deps.testFixtures)){
   const age=deps.clock.now().getTime()/1000-(auth.authenticatedAt??0);
   if(!Number.isFinite(age)||age<0||age>300)throw new DomainError('RECENT_AUTHENTICATION_REQUIRED','Sign in again before registering a workspace',401);
  }
  s.status(201).json(await requestWorkspace(deps.db,deps.clock,auth.userId,r.body,r.header('Idempotency-Key')));
 }));
 return router;
}
