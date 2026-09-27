import { parseReleaseIdentity } from "../config.js";
import express, { type Request, type Response, type NextFunction } from 'express';
import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { newId } from '../ids.js';
import { getAdminMe, requireRecentAdminAuthentication, type AdminDeps } from './auth.js';
import { parseAdminCommand, appendAdminAudit, runAdminCommand } from './audit.js';
import { ADMIN_FLAGS, type AdminFlag } from './flags.js';

const route = (fn:(req:Request,res:Response)=>Promise<void>) => (req:Request,res:Response,next:NextFunction) => { void fn(req,res).catch(next); };
const actor = (req:Request) => req.packproofUserId!;
interface AccountState { id:string; status:'ACTIVE'|'DISABLED'; admin_version:number; sessions_revoked_before:Date|string|null }
async function lockedAccount(tx:Database, id:string, version:number) {
  const row = (await tx.query<AccountState>('SELECT id,status,admin_version,sessions_revoked_before FROM users WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if (!row) throw new DomainError('USER_NOT_FOUND','Account not found',404);
  if (row.admin_version !== version) throw new DomainError('ADMIN_VERSION_CONFLICT','This account changed. Refresh before retrying.',409);
  return row;
}
export function adminUserActions(user:{id:string;status:string;adminVersion:number}, actorId?:string) {
  const base = { method:'POST' as const, risk:'high' as const, confirmation:user.id, body:{expectedVersion:user.adminVersion} };
  return [
    ...(user.id===actorId ? [] : [{...base,id:'account-status',label:user.status==='ACTIVE'?'Disable account':'Enable account',path:`/admin/users/${user.id}/status`,body:{...base.body,status:user.status==='ACTIVE'?'DISABLED':'ACTIVE'}}]),
    {...base,id:'revoke-sessions',label:'Revoke sessions',path:`/admin/users/${user.id}/revoke-sessions`},
    {...base,id:'adjust-allowance',label:'Adjust plan allowance',path:`/admin/users/${user.id}/credits`,fields:[{key:'delta',label:'Proof allowance adjustment (active plan required)',type:'number',required:true}]},
  ];
}
export async function getAdminFeatureFlags(db:Database) {
  const rows=(await db.query<{key:AdminFlag;enabled:boolean;version:number;updated_at:Date|string}>('SELECT key,enabled,version,updated_at FROM system_feature_flags ORDER BY key')).rows;
  return {items:rows.map(row=>({key:row.key,...ADMIN_FLAGS[row.key],enabled:row.enabled,version:row.version,updatedAt:row.updated_at,
    actions:[{id:'toggle',label:row.enabled?'Resume':'Pause',path:`/admin/feature-flags/${row.key}`,method:'POST',risk:'high',confirmation:row.key,body:{expectedVersion:row.version,enabled:!row.enabled}}]}))};
}
export function adminActionsRouter(deps:AdminDeps) {
  const r=express.Router();
  r.get('/me',route(async(req,res)=>{res.json({...await getAdminMe(deps.db,actor(req)),environment:deps.releaseIdentity?.environment??parseReleaseIdentity().environment});}));
  r.get('/feature-flags',route(async(_req,res)=>{res.json(await getAdminFeatureFlags(deps.db));}));
  r.get('/system',route(async(_req,res)=>{res.json({featureFlags:(await getAdminFeatureFlags(deps.db)).items,capabilities:{accountStatus:true,sessionRevocation:true,allowanceAdjustments:true,prepaidCredits:false,evidenceMutation:false,roleSelfAssignment:false},security:{recentAuthenticationRequired:!deps.devAuth,recentAuthenticationSeconds:900,roleSource:'database',mfaPolicy:'existing_cognito_user_pool'},limitations:['Allowance adjustments require an active consented billing period. They are not payments or prepaid credit purchases.','Cognito session revocation requires a fresh sign-in; refreshed tokens from older sign-ins remain rejected.']});}));
  r.post('/users/:id/status',requireRecentAdminAuthentication(deps),route(async(req,res)=>{
    const id=req.params.id; const cmd=parseAdminCommand(req.body,id,['status']);
    if (cmd.status!=='ACTIVE'&&cmd.status!=='DISABLED') throw new DomainError('INVALID_ADMIN_STATUS','Choose ACTIVE or DISABLED',400);
    const result=await runAdminCommand(deps.db,deps.clock,actor(req),'ACCOUNT_STATUS_CHANGED',id,cmd,async(tx,operationId)=>{
      const before=await lockedAccount(tx,id,cmd.expectedVersion);
      if(id===actor(req)&&cmd.status==='DISABLED') throw new DomainError('ADMIN_SELF_DISABLE','You cannot disable your own administrator account',409);
      if(cmd.status==='DISABLED') {
        const privileged=(await tx.query('SELECT 1 FROM user_system_roles WHERE user_id=$1',[id])).rows.length>0;
        const active=(await tx.query<{count:string}>("SELECT COUNT(*) AS count FROM user_system_roles r JOIN users u ON u.id=r.user_id WHERE u.status='ACTIVE'")).rows[0];
        if(privileged&&Number(active.count)<=1) throw new DomainError('LAST_ADMIN_REQUIRED','At least one active administrator must remain',409);
      }
      // Disabling also invalidates prior sessions after any later re-enable.
      const cutoff=cmd.status==='DISABLED'?deps.clock.now().toISOString():before.sessions_revoked_before;
      if(cmd.status==='DISABLED')await tx.query('UPDATE intake_scoped_sessions SET revoked_at=$2 WHERE actor_user_id=$1 AND revoked_at IS NULL',[id,cutoff]);
      const after={userId:id,status:cmd.status,adminVersion:before.admin_version+1,sessionsRevokedBefore:cutoff};
      await tx.query('UPDATE users SET status=$2,admin_version=admin_version+1,sessions_revoked_before=$3,updated_at=$4 WHERE id=$1',[id,cmd.status,cutoff,deps.clock.now().toISOString()]);
      await appendAdminAudit(tx,deps.clock,{actorId:actor(req),action:'ACCOUNT_STATUS_CHANGED',targetType:'user',targetId:id,reason:cmd.reason,before:{status:before.status,adminVersion:before.admin_version},after,operationId});
      return after;
    });res.json(result);
  }));
  r.post('/users/:id/revoke-sessions',requireRecentAdminAuthentication(deps),route(async(req,res)=>{
    const id=req.params.id;const cmd=parseAdminCommand(req.body,id);
    res.json(await runAdminCommand(deps.db,deps.clock,actor(req),'ACCOUNT_SESSIONS_REVOKED',id,cmd,async(tx,operationId)=>{
      const before=await lockedAccount(tx,id,cmd.expectedVersion);const cutoff=deps.clock.now().toISOString();
      await tx.query('UPDATE users SET sessions_revoked_before=$2,admin_version=admin_version+1,updated_at=$2 WHERE id=$1',[id,cutoff]);
      // Intake sessions have their own revocation records and cannot authenticate admin routes.
      await tx.query('UPDATE intake_scoped_sessions SET revoked_at=$2 WHERE actor_user_id=$1 AND revoked_at IS NULL',[id,cutoff]);
      const after={userId:id,adminVersion:before.admin_version+1,sessionsRevokedBefore:cutoff};
      await appendAdminAudit(tx,deps.clock,{actorId:actor(req),action:'ACCOUNT_SESSIONS_REVOKED',targetType:'user',targetId:id,reason:cmd.reason,before:{sessionsRevokedBefore:before.sessions_revoked_before},after,operationId});return after;
    }));
  }));
  r.post('/users/:id/credits',requireRecentAdminAuthentication(deps),route(async(req,res)=>{
    const id=req.params.id;const cmd=parseAdminCommand(req.body,id,['delta']);
    if(!Number.isSafeInteger(cmd.delta)||Number(cmd.delta)===0||Math.abs(Number(cmd.delta))>10000) throw new DomainError('INVALID_ALLOWANCE_ADJUSTMENT','Choose a nonzero whole number between -10000 and 10000',400);
    res.json(await runAdminCommand(deps.db,deps.clock,actor(req),'BILLING_ALLOWANCE_ADJUSTED',id,cmd,async(tx,operationId)=>{
      const account=await lockedAccount(tx,id,cmd.expectedVersion);
      const period=(await tx.query<{id:string;included:number;adjusted:string}>(`SELECT p.id,(o.definition_json->>'includedFinalizedProofs')::integer AS included,
        COALESCE((SELECT SUM(delta) FROM billing_allowance_adjustments a WHERE a.offer_period_id=p.id),0) AS adjusted
        FROM billing_account_offer_periods p JOIN billing_offer_versions o ON o.version=p.offer_version WHERE p.user_id=$1 AND p.period_start<=$2 AND p.period_end>$2`,[id,deps.clock.now().toISOString()])).rows[0];
      if(!period) throw new DomainError('BILLING_ACTIVE_PERIOD_REQUIRED','This account has no active consented plan. A prepaid credit wallet is not configured.',409);
      const before=Number(period.included)+Number(period.adjusted),after=before+Number(cmd.delta);
      const used=Number((await tx.query<{count:string}>(`SELECT COUNT(*) AS count FROM (
        SELECT proof_id FROM billing_capture_reservations WHERE offer_period_id=$1 UNION SELECT proof_id FROM billing_proof_usage WHERE offer_period_id=$1
        UNION SELECT p.id FROM proofs p JOIN proof_participants pp ON pp.proof_id=p.id AND pp.role='SELLER' JOIN billing_account_offer_periods op ON op.id=$1
        WHERE pp.user_id=$2 AND p.status='FINALIZED' AND p.finalized_at>=op.period_start AND p.finalized_at<op.period_end) used`,[period.id,id])).rows[0].count);
      if(after<used||after<0) throw new DomainError('ALLOWANCE_BELOW_RESERVED','The adjustment would remove allowance already used or reserved',409);
      const result={userId:id,offerPeriodId:period.id,delta:Number(cmd.delta),allowance:after,adminVersion:account.admin_version+1};
      await appendAdminAudit(tx,deps.clock,{actorId:actor(req),action:'BILLING_ALLOWANCE_ADJUSTED',targetType:'user',targetId:id,reason:cmd.reason,before:{allowance:before},after:result,operationId});
      await tx.query('INSERT INTO billing_allowance_adjustments(id,user_id,offer_period_id,delta,reason,actor_id,operation_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[newId('allowance'),id,period.id,cmd.delta,cmd.reason,actor(req),operationId,deps.clock.now().toISOString()]);
      await tx.query('UPDATE users SET admin_version=admin_version+1,updated_at=$2 WHERE id=$1',[id,deps.clock.now().toISOString()]);return result;
    }));
  }));
  r.post('/feature-flags/:key',requireRecentAdminAuthentication(deps),route(async(req,res)=>{
    const key=req.params.key;if(!Object.hasOwn(ADMIN_FLAGS,key)) throw new DomainError('UNKNOWN_FEATURE_FLAG','Unknown system control',404);
    const cmd=parseAdminCommand(req.body,key,['enabled']);if(typeof cmd.enabled!=='boolean') throw new DomainError('INVALID_FEATURE_FLAG','Provide enabled as a boolean',400);
    res.json(await runAdminCommand(deps.db,deps.clock,actor(req),'FEATURE_FLAG_CHANGED',key,cmd,async(tx,operationId)=>{
      const before=(await tx.query<{enabled:boolean;version:number}>('SELECT enabled,version FROM system_feature_flags WHERE key=$1 FOR UPDATE',[key])).rows[0];
      if(before.version!==cmd.expectedVersion)throw new DomainError('ADMIN_VERSION_CONFLICT','This setting changed. Refresh before retrying.',409);
      const after={key,enabled:cmd.enabled,version:before.version+1,updatedAt:deps.clock.now().toISOString()};
      await tx.query('UPDATE system_feature_flags SET enabled=$2,version=version+1,updated_at=$3,updated_by=$4 WHERE key=$1',[key,cmd.enabled,after.updatedAt,actor(req)]);
      await appendAdminAudit(tx,deps.clock,{actorId:actor(req),action:'FEATURE_FLAG_CHANGED',targetType:'feature_flag',targetId:key,reason:cmd.reason,before,after,operationId,severity:'critical'});return after;
    }));
  }));
  return r;
}
