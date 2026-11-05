import express, {type Request, type Response, type NextFunction} from 'express';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import type {AppDependencies} from '../app.js';
import {DomainError} from '../domain/errors.js';
import type {PartnerActor} from '../platform/organizations.js';
import type {RecordWorkspace} from './access.js';
import {requireRecordWorkspace} from './access.js';
import {requestOperationalSnapshot, getOperationalSnapshot, listOperationalSnapshots, previewOperationalSnapshot, streamOperationalSnapshotPackage} from './operational-snapshots.js';

/** Admission is deliberately human-only; a service key cannot attest or sign. */
export function createOperationalSnapshotsRouter(deps: AppDependencies) {
  const router = express.Router();
  const run = (fn: (r: Request, s: Response) => Promise<void>) => (r: Request, s: Response, n: NextFunction) => {
    void fn(r, s).catch(error => { if (s.headersSent || s.destroyed) s.destroy(); else n(error); });
  };
  async function workspace(r: Request, write = false) {
    const auth = await deps.auth.authenticate(r.headers);
    return requireRecordWorkspace(deps.db, auth.userId, r.query.organizationId, r.query.environment, write);
  }
  router.use((_r, s, next) => { s.setHeader('Cache-Control', 'private, no-store'); s.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
  router.get('/:proofId/snapshots', run(async (r, s) => {
    s.json(await listOperationalSnapshots(deps.db, await workspace(r), r.params.proofId, deps.operationalSnapshots));
  }));
  router.post('/:proofId/snapshots', run(async (r, s) => {
    const result = await requestOperationalSnapshot(deps.db, deps.clock, await workspace(r, true), r.params.proofId, r.body, r.header('If-Match'), r.header('Idempotency-Key'), deps.operationalSnapshots);
    s.setHeader('Location', `/me/records/${encodeURIComponent(r.params.proofId)}/snapshots/${encodeURIComponent(result.snapshotId)}?organizationId=${encodeURIComponent(String(r.query.organizationId))}&environment=${encodeURIComponent(String(r.query.environment))}`);
    s.status(202).json(result);
  }));
  router.get('/:proofId/snapshots/:snapshotId', run(async (r, s) => {
    s.json(await getOperationalSnapshot(deps.db, await workspace(r), r.params.proofId, r.params.snapshotId, deps.operationalSnapshots));
  }));
  router.get('/:proofId/snapshots/:snapshotId/manifest', run(async (r, s) => {
    s.json(await previewOperationalSnapshot(deps.db, await workspace(r), r.params.proofId, r.params.snapshotId, deps.operationalSnapshots));
  }));
  router.get('/:proofId/snapshots/:snapshotId/package', run(async (r, s) => {
    const stream = await streamOperationalSnapshotPackage(deps.db, await workspace(r), r.params.proofId, r.params.snapshotId, deps.operationalSnapshots);
    s.setHeader('Content-Type', 'application/zip');
    s.setHeader('Content-Disposition', 'attachment; filename="packproof-operational-snapshot.zip"');
    await pipeline(Readable.from(stream), s);
  }));
  return router;
}
/** Services can retrieve already accepted snapshots under current read grants;
 * admission and signing requests remain on the deliberate human route above. */
export function createPartnerOperationalSnapshotsRouter(deps:AppDependencies){
 const router=express.Router(),run=(fn:(r:Request,s:Response)=>Promise<void>)=>(r:Request,s:Response,n:NextFunction)=>void fn(r,s).catch(e=>{if(s.headersSent||s.destroyed)s.destroy();else n(e);});
 function workspace(r:Request):RecordWorkspace {const a=(r as Request&{partnerActor:PartnerActor}).partnerActor;if(!a)throw new DomainError('UNAUTHENTICATED','A service credential is required.',401);return {organizationId:a.merchantId,environment:a.environment,tenantId:a.tenantId,membershipId:'',userId:a.actorUserId,role:'OPERATOR',enabled:true,locationScoped:false,partner:a,authorizationClock:deps.clock};}
 router.use((_r,s,n)=>{s.setHeader('Cache-Control','private, no-store');s.setHeader('X-Content-Type-Options','nosniff');n();});
 router.get('/proofs/:proofId/operational-snapshots',run(async(r,s)=>{s.json(await listOperationalSnapshots(deps.db,workspace(r),r.params.proofId,deps.operationalSnapshots));}));
 router.get('/proofs/:proofId/operational-snapshots/:snapshotId',run(async(r,s)=>{s.json(await getOperationalSnapshot(deps.db,workspace(r),r.params.proofId,r.params.snapshotId,deps.operationalSnapshots));}));
 router.get('/proofs/:proofId/operational-snapshots/:snapshotId/manifest',run(async(r,s)=>{s.json(await previewOperationalSnapshot(deps.db,workspace(r),r.params.proofId,r.params.snapshotId,deps.operationalSnapshots));}));
 router.get('/proofs/:proofId/operational-snapshots/:snapshotId/package',run(async(r,s)=>{const stream=await streamOperationalSnapshotPackage(deps.db,workspace(r),r.params.proofId,r.params.snapshotId,deps.operationalSnapshots);s.setHeader('Content-Type','application/zip');s.setHeader('Content-Disposition','attachment; filename="packproof-operational-snapshot.zip"');await pipeline(Readable.from(stream),s);}));
 return router;
}
