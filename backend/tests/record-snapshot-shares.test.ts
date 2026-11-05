import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {createTransaction} from '../src/domain/transactions.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
import {createOrganization,setOrganizationEntitlement,addOrganizationMember,revokeOrganizationMember} from '../src/platform/organizations.js';
import {requireRecordWorkspace,type RecordWorkspace} from '../src/records/access.js';
import {createCanonicalExport,processPendingCanonicalExports} from '../src/records/partner-exports.js';
import {createSnapshotShare,listSnapshotShares,revokeSnapshotShare,readSnapshotShare,openSnapshotShare} from '../src/records/snapshot-shares.js';
import {LocalObjectStore} from '../src/s3/local-object-store.js';
import {commitFulfillmentAndAttest,type TestHarness} from './helpers.js';
import {finalizeProof} from '../src/domain/finalize.js';
import type {AppDependencies} from '../src/app.js';
let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,dir:string,deps:AppDependencies,w:RecordWorkspace,owner:string,org:string,proof:string,jobId:string,token:string,shareId:string;
let now=Date.now();const clock={now:()=>new Date(now)},person=()=>({kind:'HUMAN' as const,workspace:w});
const body=()=>({proofId:proof,target:{kind:'CANONICAL_EXPORT',id:jobId},expiresAt:new Date(now+3600000).toISOString(),recipientHint:'Claims reviewer',downloadedCopiesAcknowledged:true});
beforeAll(async()=>{
 vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED','true');opened=await openIsolatedTestDatabase();await migrate(opened.db);dir=await mkdtemp(join(tmpdir(),'snapshot-share-'));const store=new LocalObjectStore(dir,'http://example.test','test');const admin=await insertUser(opened.db,clock);owner=await insertUser(opened.db,clock);await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);org=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Snapshot share test',ownerUserId:owner},'test')).id;await setOrganizationEntitlement(opened.db,clock,admin,org,{enabled:true},'test');w=await requireRecordWorkspace(opened.db,owner,org,'sandbox');const tx=await createTransaction(opened.db,clock,owner,{itemTitle:'Shared fixed inventory'});proof=(await createOrGetProof(opened.db,clock,owner,tx.transactionId,{participationPolicy:'COUNTERPARTY_OPTIONAL'})).proofId;await opened.db.query('INSERT INTO platform_proof_ownership(proof_id,merchant_id,environment,operator_membership_id,origin_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',[proof,org,'sandbox',w.membershipId,owner,clock.now().toISOString()]);await commitFulfillmentAndAttest({db:opened.db,clock,objectStore:store} as TestHarness,owner,proof);const manifest=await finalizeProof(opened.db,clock,owner,proof);deps={db:opened.db,clock,objectStore:store,devAuth:true,webhookConfig:{encryptionKey:randomBytes(32).toString('base64'),allowedHosts:[]}} as AppDependencies;jobId=(await createCanonicalExport(deps,person(),'export',{proofId:proof,kind:'CORE',snapshotId:manifest.manifest.manifestId})).value.id;expect(await processPendingCanonicalExports(deps)).toEqual({processed:1,failed:0});
},90000);
afterAll(async()=>{await opened?.close();if(dir){const rel=relative(resolve(tmpdir()),resolve(dir));if(!rel||rel.startsWith('..')||rel.includes(':'))throw Error('Unsafe cleanup');await rm(dir,{recursive:true,force:true});}vi.unstubAllEnvs();});
it('shares one fixed package with an encrypted replay response and no raw token in stored policy or audit',async()=>{
 const input=body(),result=await createSnapshotShare(deps,person(),'share-one',input);token=result.value.token;shareId=result.value.id;expect(result.value.reviewPath).toBe(`/review-package#${token}`);expect((await createSnapshotShare(deps,person(),'share-one',input)).value.token).toBe(token);expect((await readSnapshotShare(deps,token)).liveRecordAvailable).toBe(false);expect(JSON.stringify((await listSnapshotShares(deps,person(),proof)))).not.toContain(token);const saved=JSON.stringify((await opened.db.query('SELECT * FROM record_snapshot_shares')).rows);expect(saved).not.toContain(token);expect(JSON.stringify((await opened.db.query('SELECT response FROM api_idempotency WHERE operation LIKE $1',['snapshot-share:%'])).rows)).not.toContain(token);const stream=await openSnapshotShare(deps,token),chunks:Buffer[]=[];for await(const c of stream)chunks.push(Buffer.from(c));expect(Buffer.concat(chunks).toString()).toContain('FROZEN_CORE_ONLY');
});
it('requires deliberate disclosure and prevents a share from exceeding stored package availability',async()=>{
 await expect(createSnapshotShare(deps,person(),'unreviewed',{...body(),downloadedCopiesAcknowledged:false})).rejects.toMatchObject({code:'SHARE_REVIEW_REQUIRED'});
 await expect(createSnapshotShare(deps,person(),'too-late',{...body(),expiresAt:new Date(now+2*86400000).toISOString()})).rejects.toMatchObject({code:'SHARE_EXCEEDS_DOWNLOAD_AVAILABILITY'});
 await expect(readSnapshotShare(deps,token+'x')).rejects.toMatchObject({code:'SHARE_UNAVAILABLE'});
 await expect(opened.db.query("UPDATE record_snapshot_shares SET target_id='different' WHERE id=$1",[shareId])).rejects.toThrow(/immutable/);
});
it('revokes an already-open response and prevents cached idempotency replay from resurrecting access',async()=>{
 const stream=await openSnapshotShare(deps,token);await revokeSnapshotShare(deps,person(),shareId,{reason:'Review completed'});await expect(async()=>{for await(const _ of stream){}}).rejects.toMatchObject({code:'SHARE_UNAVAILABLE'});await expect(readSnapshotShare(deps,token)).rejects.toMatchObject({code:'SHARE_UNAVAILABLE'});await expect(createSnapshotShare(deps,person(),'share-one',body())).rejects.toMatchObject({code:'SHARE_UNAVAILABLE'});expect(await revokeSnapshotShare(deps,person(),shareId,{reason:'Already completed'})).toMatchObject({revoked:true});
});
it('rechecks current issuer membership and expiration independently of a valid share secret',async()=>{
 const user=await insertUser(opened.db,clock),member=await addOrganizationMember(opened.db,clock,owner,org,{userId:user,role:'ADMIN'},'test'),workspace=await requireRecordWorkspace(opened.db,user,org,'sandbox'),o={kind:'HUMAN' as const,workspace};const original=await createCanonicalExport(deps,o,'admin-export',{proofId:proof,kind:'CORE',snapshotId:(await opened.db.query<{id:string}>('SELECT id FROM final_manifests WHERE proof_id=$1',[proof])).rows[0].id});await processPendingCanonicalExports(deps);const result=await createSnapshotShare(deps,o,'admin-share',{...body(),target:{kind:'CANONICAL_EXPORT',id:original.value.id}});await revokeOrganizationMember(opened.db,clock,owner,org,String(member.id),'test');await expect(readSnapshotShare(deps,result.value.token)).rejects.toMatchObject({code:'SHARE_UNAVAILABLE'});const expires=await createSnapshotShare(deps,person(),'short',{...body(),expiresAt:new Date(now+1000).toISOString()});now+=1001;await expect(openSnapshotShare(deps,expires.value.token)).rejects.toMatchObject({code:'SHARE_UNAVAILABLE'});
});
it('records permanent revocation in the independently replayed policy journal',async()=>{
 const changes=(await opened.db.query<{after_json:{revoked_at:string|null}}> ('SELECT after_json FROM policy_recovery_events WHERE table_name=$1 AND after_json->>\'id\'=$2 ORDER BY sequence',['record_snapshot_shares',shareId])).rows;expect(changes.length).toBe(2);expect(changes[1].after_json.revoked_at).not.toBeNull();
});
