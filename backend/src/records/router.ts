import express,{type Request,type Response,type NextFunction} from 'express';
import type { AppDependencies } from '../app.js';
import { DomainError } from '../domain/errors.js';
import { requireActiveAccount } from '../domain/account-access.js';
import { assertPolicyAccessSafe } from '../domain/policy-recovery.js';
import { requireHumanActor } from '../platform/organization-access.js';
import { authorizePartnerProof,reauthorizePartner,type PartnerActor } from '../platform/organizations.js';
import { partnerProblem } from '../platform/partner-router.js';
import {reconstructionFeatureEnabled} from './reconstruction-features.js';
import {listRecordReviewers,assignRecordIssue} from './issue-assignments.js';
import {resolveRecordEntityReference} from './service.js';
import { requireRecordWorkspace,listRecordLocations,requireRecordAccess,type RecordWorkspace } from './access.js';
import { listRecordConnections } from './connections.js';
import {listSourceAssociations,approveSourceCrosswalk,replaySourceAssociation} from './source-associations.js';
import { getRecord,listRecords,readRecordEvidence,readRecordIssues,readRecordRequirements,readRecordTimeline,
  recordCommand,patchRecord,changeRecordLifecycle,addRequirement,waiveRequirement,actOnIssue,appendAmendment,addRecordEntity,linkRecordEvidence,pageRecordEvidence,pageRecordTimeline,reviewRecord } from './service.js';

const run=(fn:(r:Request,s:Response)=>Promise<void>)=>(r:Request,s:Response,n:NextFunction)=>{void fn(r,s).catch(n);};
type PartnerRequest=Request&{partnerActor:PartnerActor};
export function createRecordsRouter(deps:AppDependencies) {
  const router=express.Router();
  router.use((_r,s,n)=>{s.setHeader('Cache-Control','private, no-store');n();});
  async function identity(r:Request){const auth=await deps.auth.authenticate(r.headers);await requireActiveAccount(deps.db,auth.userId);await requireHumanActor(deps.db,auth.userId);return auth.userId;}
  async function workspace(r:Request,write=false) {
    const userId=await identity(r);
    return requireRecordWorkspace(deps.db,userId,r.query.organizationId??r.body?.organizationId,r.query.environment??r.body?.environment,write);
  }
  router.get('/context',run(async(r,s)=>{
    const userId=await identity(r);await assertPolicyAccessSafe(deps.db);
    const rows=(await deps.db.query<any>(`SELECT o.id,o.name,o.environment,o.enabled,o.tenant_id,m.role,m.id AS membership_id,m.location_scoped
      FROM platform_organizations o JOIN platform_memberships m ON m.organization_id=o.id
      WHERE m.user_id=$1 AND m.revoked_at IS NULL AND o.kind='MERCHANT' ORDER BY o.name,o.id`,[userId])).rows;
    const featureEnabled=process.env.PACKPROOF_ORGANIZATIONS_ENABLED==='true';
    const organizations=[];
    for(const row of rows){const w:RecordWorkspace={organizationId:row.id,environment:row.environment,tenantId:row.tenant_id,membershipId:row.membership_id,userId,role:row.role,enabled:row.enabled,locationScoped:row.location_scoped};
      organizations.push({id:row.id,name:row.name,environment:row.environment,enabled:row.enabled&&featureEnabled,role:row.role,locations:await listRecordLocations(deps.db,w)});}
    const selected=organizations.find(o=>o.id===r.query.organizationId)??organizations.find(o=>o.enabled)??organizations[0];
    if(r.query.organizationId&&!organizations.some(o=>o.id===r.query.organizationId))throw new DomainError('ORGANIZATION_NOT_FOUND','Organization not found',404);
    s.json({schema:'packproof.records/v1',organizations,selectedOrganizationId:selected?.id??null,environment:selected?.environment??null,
      capabilities:{crossCase:reconstructionFeatureEnabled('crossCase'),sourceIdentityV2:reconstructionFeatureEnabled('sourceIdentityV2'),sourceRulePolicies:reconstructionFeatureEnabled('sourceRulePolicies'),signedCaseExports:reconstructionFeatureEnabled('signedExports')&&!!deps.reconstructionSigning,sourceDisposition:reconstructionFeatureEnabled('sourceDisposition'),records:!!selected?.enabled,import:!!selected?.enabled&&selected.role!=='REVIEWER',review:!!selected?.enabled&&selected.role!=='REVIEWER',manage:!!selected?.enabled&&['OWNER','ADMIN'].includes(selected.role),reconstruction:!!selected?.enabled&&reconstructionFeatureEnabled('reconstruction'),reconstructionExports:!!selected?.enabled&&reconstructionFeatureEnabled('reconstruction')&&reconstructionFeatureEnabled('exports'),sourceSubscriptions:!!selected?.enabled&&reconstructionFeatureEnabled('sourceSubscriptions')},
      activation:featureEnabled?'organization_entitlement':'platform_activation_pending'});
  }));
  router.get('/',run(async(r,s)=>{const w=await workspace(r);s.json(await listRecords(deps.db,deps.clock,w,r.query));}));
  router.get('/connections',run(async(r,s)=>{const w=await workspace(r);s.json(await listRecordConnections(deps.db,deps.clock,w));}));
  router.get('/source-associations',run(async(r,s)=>{const w=await workspace(r);s.json(await listSourceAssociations(deps.db,w,{before:r.query.before,limit:r.query.limit}));}));
  router.post('/source-crosswalks',run(async(r,s)=>{const w=await workspace(r,true);s.json(await approveSourceCrosswalk(deps.db,deps.clock,w,r.body,r.header('Idempotency-Key')));}));
  router.post('/source-associations/:associationId/replay',run(async(r,s)=>{const w=await workspace(r,true);s.status(202).json(await replaySourceAssociation(deps.db,deps.clock,w,r.params.associationId,r.body,r.header('Idempotency-Key')));}));
  router.get('/issues',run(async(r,s)=>{const w=await workspace(r);const page=await listRecords(deps.db,deps.clock,w,{...r.query,view:'needs_attention',limit:100}),issues=[];
    for(const record of page.records){await requireRecordAccess(deps.db,w,record.id);issues.push(...(await readRecordIssues(deps.db,record.id)).filter(i=>i.status!=='resolved'));}
    s.json({issues,nextCursor:page.nextCursor,updatedAt:page.updatedAt});}));
  router.get('/exports',run(async(r,s)=>{const w=await workspace(r);
    const rows=(await deps.db.query<any>(`SELECT j.operation_id AS id,j.proof_id AS "proofId",j.record_type AS "recordType",j.record_id AS "recordId",j.created_at AS "createdAt",d.state,d.error_code AS "errorCode",z.accepted_at AS "acceptedAt"
      FROM integrity_envelope_jobs j JOIN platform_proof_ownership o ON o.proof_id=j.proof_id
      LEFT JOIN record_state rs ON rs.proof_id=o.proof_id JOIN integrity_envelope_delivery d ON d.operation_id=j.operation_id
      LEFT JOIN integrity_envelope_results z ON z.operation_id=j.operation_id
      WHERE o.merchant_id=$1 AND o.environment=$2 AND ($3::text<>'OPERATOR' OR o.operator_membership_id=$4)
      AND ($5::boolean=false OR EXISTS(SELECT 1 FROM record_membership_locations l WHERE l.membership_id=$4 AND l.organization_id=o.merchant_id AND l.location_id=rs.location_id))
      ORDER BY j.created_at DESC,j.operation_id DESC LIMIT 100`,[w.organizationId,w.environment,w.role,w.membershipId,w.locationScoped])).rows;
    s.json({exports:rows.map(e=>({...e,kind:'signed_snapshot',state:e.state==='ACCEPTED'?'succeeded':e.state==='DEAD_LETTER'?'failed':e.state==='LEASED'?'running':'queued',downloadAvailable:false}))});}));
  router.get('/:proofId/timeline',run(async(r,s)=>{const w=await workspace(r);s.json(await pageRecordTimeline(deps.db,deps.clock,w,r.params.proofId,r.query));}));
  router.get('/:proofId/evidence',run(async(r,s)=>{const w=await workspace(r);s.json(await pageRecordEvidence(deps.db,deps.clock,w,r.params.proofId,r.query));}));
  router.get('/:proofId/requirements',run(async(r,s)=>{const w=await workspace(r);await requireRecordAccess(deps.db,w,r.params.proofId);s.json({requirements:await readRecordRequirements(deps.db,deps.clock,r.params.proofId)});}));
  router.get('/:proofId/entity-matches',run(async(r,s)=>{s.json(await resolveRecordEntityReference(deps.db,await workspace(r),r.params.proofId,r.query.reference));}));
  router.get('/:proofId/issue-reviewers',run(async(r,s)=>{s.json(await listRecordReviewers(deps.db,deps.clock,await workspace(r),r.params.proofId));}));
  router.get('/:proofId',run(async(r,s)=>{const w=await workspace(r),result=await getRecord(deps.db,deps.clock,w,r.params.proofId);const runtime=deps.operationalSnapshots;try{runtime?.assertReady();result.capabilities.operationalSnapshots=!!runtime&&['OWNER','ADMIN'].includes(w.role)&&runtime.binding.environment===w.environment&&runtime.binding.organizationIds.includes(w.organizationId);}catch{result.capabilities.operationalSnapshots=false;}s.setHeader('ETag',`"${result.record.revision}"`);s.json(result);}));
  function command(method:'post'|'patch',path:string,fn:(r:Request,w:RecordWorkspace,tx:AppDependencies['db'],proofId:string)=>Promise<unknown>,issue=false) {
    router[method](path,run(async(r,s)=>{
      const w=await workspace(r,true);
      const proofId=issue?(await deps.db.query<{proof_id:string}>(`SELECT i.proof_id FROM record_issues i JOIN platform_proof_ownership o ON o.proof_id=i.proof_id
        LEFT JOIN record_state rs ON rs.proof_id=i.proof_id WHERE i.id=$1 AND o.merchant_id=$2 AND o.environment=$3
        AND ($4::text<>'OPERATOR' OR o.operator_membership_id=$5)
        AND ($6::boolean=false OR EXISTS(SELECT 1 FROM record_membership_locations lg WHERE lg.membership_id=$5 AND lg.organization_id=o.merchant_id AND lg.location_id=rs.location_id))`,[r.params.issueId,w.organizationId,w.environment,w.role,w.membershipId,w.locationScoped])).rows[0]?.proof_id:r.params.proofId;
      if(!proofId)throw new DomainError('ISSUE_NOT_FOUND','Issue not found',404);
      const result=await recordCommand(deps.db,deps.clock,w,proofId,`${method.toUpperCase()} ${r.path}`,r.header('Idempotency-Key'),r.header('If-Match'),r.body,tx=>fn(r,w,tx,proofId));
      s.setHeader('Idempotency-Replayed',String(result.replayed));s.json(result.value);
    }));
  }
  command('patch','/:proofId',(r,w,db,id)=>patchRecord(db,deps.clock,w,id,r.body));
  command('post','/:proofId/close',(r,w,db,id)=>changeRecordLifecycle(db,deps.clock,w,id,'close',r.body));
  command('post','/:proofId/reopen',(r,w,db,id)=>changeRecordLifecycle(db,deps.clock,w,id,'reopen',r.body));
  command('post','/:proofId/review',(r,w,db,id)=>reviewRecord(db,deps.clock,w,id,r.body));
  command('post','/:proofId/requirements',(r,w,db,id)=>addRequirement(db,deps.clock,w,id,r.body));
  command('post','/:proofId/requirements/:requirementId/waiver',(r,w,db,id)=>waiveRequirement(db,deps.clock,w,id,r.params.requirementId,r.body));
  command('post','/:proofId/amendments',(r,w,db,id)=>appendAmendment(db,deps.clock,w,id,r.body));
  command('post','/:proofId/entities',(r,w,db,id)=>addRecordEntity(db,deps.clock,w,id,r.body));
  command('post','/:proofId/evidence-links',(r,w,db,id)=>linkRecordEvidence(db,deps.clock,w,id,r.body));
  command('post','/issues/:issueId/assignment',(r,w,db,id)=>assignRecordIssue(db,deps.clock,w,id,r.params.issueId,r.body),true);
  command('post','/issues/:issueId/actions',(r,w,db,id)=>actOnIssue(db,deps.clock,w,id,r.params.issueId,r.body),true);
  router.use(partnerProblem);return router;
}

/** Mounted after the existing partner authentication middleware. No service
 * credential acquires personal capture, attestation or waiver authority. */
export function createPartnerRecordsRouter(deps:AppDependencies) {
  const router=express.Router();
  function workspace(req:Request):RecordWorkspace {
    const a=(req as PartnerRequest).partnerActor;
    if(!a)throw new DomainError('UNAUTHENTICATED','An organization service credential is required',401);
    return {organizationId:a.merchantId,environment:a.environment,tenantId:a.tenantId,membershipId:'',userId:a.actorUserId,role:'OPERATOR',enabled:true,locationScoped:false,partner:a,authorizationClock:deps.clock};
  }
  function read(path:string,fn:(r:Request,w:RecordWorkspace)=>Promise<unknown>){router.get(path,run(async(r,s)=>{const w=workspace(r);await authorizePartnerProof(deps.db,deps.clock,w.partner!,r.params.proofId,'proofs:read');await requireRecordAccess(deps.db,w,r.params.proofId);s.json(await fn(r,w));}));}
  read('/proofs/:proofId/entity-matches',(r,w)=>resolveRecordEntityReference(deps.db,w,r.params.proofId,r.query.reference));
  read('/proofs/:proofId/record',(r,w)=>getRecord(deps.db,deps.clock,w,r.params.proofId));
  read('/proofs/:proofId/timeline',async(r,w)=>pageRecordTimeline(deps.db,deps.clock,w,r.params.proofId,r.query));
  read('/proofs/:proofId/evidence',async(r,w)=>pageRecordEvidence(deps.db,deps.clock,w,r.params.proofId,r.query));
  read('/proofs/:proofId/requirements',async(r)=>({requirements:await readRecordRequirements(deps.db,deps.clock,r.params.proofId)}));
  function command(method:'post'|'patch',path:string,fn:(r:Request,w:RecordWorkspace,tx:AppDependencies['db'])=>Promise<unknown>){router[method](path,run(async(r,s)=>{
    const w=workspace(r);await reauthorizePartner(deps.db,deps.clock,w.partner!,'proofs:write');
    const result=await recordCommand(deps.db,deps.clock,w,r.params.proofId,`partner:${method.toUpperCase()} ${r.path}`,r.header('Idempotency-Key'),r.header('If-Match'),r.body,tx=>fn(r,w,tx));
    s.setHeader('Idempotency-Replayed',String(result.replayed));s.json(result.value);
  }));}
  command('patch','/proofs/:proofId',(r,w,db)=>patchRecord(db,deps.clock,w,r.params.proofId,r.body));
  command('post','/proofs/:proofId/close',(r,w,db)=>changeRecordLifecycle(db,deps.clock,w,r.params.proofId,'close',r.body));
  command('post','/proofs/:proofId/reopen',(r,w,db)=>changeRecordLifecycle(db,deps.clock,w,r.params.proofId,'reopen',r.body));
  command('post','/proofs/:proofId/amendments',(r,w,db)=>appendAmendment(db,deps.clock,w,r.params.proofId,r.body));
  command('post','/proofs/:proofId/entities',(r,w,db)=>addRecordEntity(db,deps.clock,w,r.params.proofId,r.body));
  command('post','/proofs/:proofId/evidence-links',(r,w,db)=>linkRecordEvidence(db,deps.clock,w,r.params.proofId,r.body));
  return router;
}
