import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { requireActiveAccount } from '../domain/account-access.js';
import { assertPolicyAccessSafe } from '../domain/policy-recovery.js';
import { requireHumanActor } from '../platform/organization-access.js';
import type { RecordEnvironment } from './types.js';
import { authorizePartnerProof,reauthorizePartner,type PartnerActor } from '../platform/organizations.js';
import type { Clock } from '../clock.js';

export interface RecordWorkspace {
  organizationId:string; environment:RecordEnvironment; tenantId:string; membershipId:string;
  userId:string; role:'OWNER'|'ADMIN'|'OPERATOR'|'REVIEWER'; enabled:boolean; locationScoped:boolean;
  partner?:PartnerActor;
  authorizationClock?:Clock;
}
export function requireRecordsFeature() {
  if(process.env.PACKPROOF_ORGANIZATIONS_ENABLED!=='true')
    throw new DomainError('PARTNER_PLATFORM_DISABLED','Organization access is waiting for activation',503);
}
export async function requireRecordWorkspace(db:Database,userId:string,organizationId:unknown,environment:unknown,write=false):Promise<RecordWorkspace> {
  requireRecordsFeature();
  await assertPolicyAccessSafe(db); await requireActiveAccount(db,userId); await requireHumanActor(db,userId);
  if(typeof organizationId!=='string'||!organizationId||!['sandbox','live'].includes(String(environment)))
    throw new DomainError('WORKSPACE_REQUIRED','Select an organization and its environment',400);
  const row=(await db.query<{id:string;environment:RecordEnvironment;tenant_id:string;membership_id:string;role:RecordWorkspace['role'];enabled:boolean;location_scoped:boolean}>(`
    SELECT o.id,o.environment,o.tenant_id,o.enabled,m.id AS membership_id,m.role,m.location_scoped
    FROM platform_organizations o JOIN platform_memberships m ON m.organization_id=o.id
    WHERE o.id=$1 AND o.environment=$2 AND o.kind='MERCHANT' AND m.user_id=$3 AND m.revoked_at IS NULL
    FOR SHARE OF o,m`,[organizationId,environment,userId])).rows[0];
  if(!row)throw new DomainError('ORGANIZATION_NOT_FOUND','Organization not found',404);
  if(!row.enabled)throw new DomainError('WORKSPACE_PENDING','This workspace is waiting for API activation',409);
  if(write&&row.role==='REVIEWER')throw new DomainError('RECORD_PERMISSION_DENIED','Your role permits review access only',403);
  return {organizationId:row.id,environment:row.environment,tenantId:row.tenant_id,membershipId:row.membership_id,userId,role:row.role,enabled:row.enabled,locationScoped:row.location_scoped};
}
export async function listRecordLocations(db:Database,workspace:RecordWorkspace) {
  return (await db.query<{id:string;name:string}>(`SELECT l.id,l.name FROM record_locations l WHERE l.organization_id=$1
    AND ($2::boolean=false OR EXISTS(SELECT 1 FROM record_membership_locations g WHERE g.location_id=l.id AND g.organization_id=l.organization_id AND g.membership_id=$3)) ORDER BY l.name,l.id`,[workspace.organizationId,workspace.locationScoped,workspace.membershipId])).rows;
}
export async function requireRecordLocation(db:Database,workspace:RecordWorkspace,locationId:unknown) {
  if(locationId==null||locationId==='') {
    if(workspace.locationScoped)throw new DomainError('LOCATION_REQUIRED','Choose one of your authorized locations',403);
    return null;
  }
  if(typeof locationId!=='string')throw new DomainError('INVALID_LOCATION','Choose an authorized location',400);
  const row=(await db.query(`SELECT 1 FROM record_locations l WHERE l.id=$1 AND l.organization_id=$2
    AND ($3::boolean=false OR EXISTS(SELECT 1 FROM record_membership_locations g WHERE g.location_id=l.id AND g.organization_id=l.organization_id AND g.membership_id=$4))`,[locationId,workspace.organizationId,workspace.locationScoped,workspace.membershipId])).rows[0];
  if(!row)throw new DomainError('LOCATION_NOT_FOUND','Location not found',404);return locationId;
}
export async function requireRecordAccess(db:Database,workspace:RecordWorkspace,proofId:string,write=false) {
  if(workspace.partner){
    requireRecordsFeature();
    await authorizePartnerProof(db,workspace.authorizationClock??{now:()=>new Date()},workspace.partner,proofId,write?'proofs:write':'proofs:read');
    // Location-restricted records require an explicit current operator/location
    // grant. Existing delegation grants contain operator identities, not sites.
    const location=(await db.query<{location_id:string|null}>('SELECT location_id FROM record_state WHERE proof_id=$1',[proofId])).rows[0]?.location_id;
    if(location&&workspace.partner.delegationGrantId)throw new DomainError('LOCATION_GRANT_REQUIRED','This delegated route does not have an explicit location grant',403);
    return workspace;
  }
  const current=await requireRecordWorkspace(db,workspace.userId,workspace.organizationId,workspace.environment,write);
  const row=(await db.query<{location_id:string|null;operator_membership_id:string}>(`SELECT s.location_id,p.operator_membership_id
    FROM platform_proof_ownership p LEFT JOIN record_state s ON s.proof_id=p.proof_id
    WHERE p.proof_id=$1 AND p.merchant_id=$2 AND p.environment=$3`,[proofId,current.organizationId,current.environment])).rows[0];
  if(!row)throw new DomainError('PROOF_NOT_FOUND','Record not found',404);
  if(current.role==='OPERATOR'&&row.operator_membership_id!==current.membershipId)
    throw new DomainError('PROOF_NOT_FOUND','Record not found',404);
  try{await requireRecordLocation(db,current,row.location_id);}catch(error){if(error instanceof DomainError)throw new DomainError('PROOF_NOT_FOUND','Record not found',404);throw error;}
  return current;
}
export async function reauthorizeRecordWorkspace(db:Database,workspace:RecordWorkspace,write=false) {
  if(workspace.partner){requireRecordsFeature();await reauthorizePartner(db,workspace.authorizationClock??{now:()=>new Date()},workspace.partner,write?'proofs:write':'proofs:read');return workspace;}
  return requireRecordWorkspace(db,workspace.userId,workspace.organizationId,workspace.environment,write);
}
