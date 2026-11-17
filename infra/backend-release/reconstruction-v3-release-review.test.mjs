import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {reconstructionDigest,validateReconstructionReview,inspectReconstructionInventory,validateReconstructionTaskMetadata,inspectReconstructionPlatformLocks} from './reconstruction-v3-release-review.mjs';
import {inspectReconstructionInventory as inspect116Inventory} from './reconstruction-v2-release-review.mjs';
import {runReconstructionPreflight} from './reconstruction-v3-runtime-preflight.mjs';
const now=new Date('2026-11-14T12:00:00Z');
const review=()=>({schema:'packproof.reconstruction-release-review/v3',source:'a'.repeat(40),apiRole:'backfill_api',workerRole:'backfill_worker',ownerRole:'backfill_owner',inventorySha256:'b'.repeat(64),recordsMigrationSha256:'c'.repeat(64),target:{host:'isolated-restore.example.invalid',database:'backfill_test'},clusterArn:'arn:aws:ecs:us-east-1:123456789012:cluster/backfill',candidateImage:'123456789012.dkr.ecr.us-east-1.amazonaws.com/packproof@sha256:'+'d'.repeat(64),expiresAt:'2026-11-14T13:00:00Z',featureActivation:false,customerReleaseQualified:false});
test('requires a separate117 review while retaining source, image, role, target and non-activation boundaries',()=>{
 const r=review(),hash=reconstructionDigest(r);assert.equal(validateReconstructionReview(r,hash,r.source,now),hash);
 for(const changed of [{...r,schema:'packproof.reconstruction-release-review/v2'},{...r,workerRole:r.apiRole},{...r,featureActivation:true},{...r,customerReleaseQualified:true},{...r,expiresAt:'2026-11-14T11:00:00Z'},{...r,target:{...r.target,host:'https://unreviewed/'}}])assert.throws(()=>validateReconstructionReview(changed,reconstructionDigest(changed),r.source,now),/^Error: RECONSTRUCTION_/);
 assert.throws(()=>validateReconstructionReview({...r,source:'e'.repeat(40)},hash,r.source,now),/BINDING/);
 const task={TaskARN:r.clusterArn.replace(':cluster/',':task/')+'/'+'a'.repeat(32)},container={Image:r.candidateImage,ImageID:r.candidateImage.split('@')[1]};assert.equal(validateReconstructionTaskMetadata(container,task,r).image,r.candidateImage);
 assert.throws(()=>validateReconstructionTaskMetadata({...container,Image:r.candidateImage.split('@')[0]+':latest'},task,r),/IMAGE_CLUSTER/);
});
test('accepts exactly117 on the frozen116 predecessor and never relaxes the old116 inventory guard',async()=>{
 const directory=new URL('../../backend/migrations/',import.meta.url),files=(await readdir(directory)).filter(name=>name.endsWith('.sql')&&Number(name.slice(0,3))<=117).sort();
 const inventory=await Promise.all(files.map(async name=>{const sql=await readFile(new URL(name,directory),'utf8');return {id:name.slice(0,-4),sql,checksum:reconstructionDigest(sql)};}));
 const applied=inventory.map(({id,checksum})=>({id,checksum})),r={...review(),inventorySha256:reconstructionDigest(applied)};
 assert.equal(inspectReconstructionInventory(inventory,applied,r).sourceCount,116);assert.throws(()=>inspect116Inventory(inventory,applied,r),/SOURCE/);
 const base=inventory.filter(row=>row.id!=='117_source_backfill_jobs'),baseApplied=base.map(({id,checksum})=>({id,checksum}));assert.equal(inspect116Inventory(base,baseApplied,{...r,inventorySha256:reconstructionDigest(baseApplied)}).sourceCount,115);
 assert.throws(()=>inspectReconstructionInventory(inventory,applied.slice(0,-1),r),/APPLIED/);
 assert.throws(()=>inspectReconstructionInventory([...inventory,{id:'118_unreviewed',sql:'SELECT 1',checksum:reconstructionDigest('SELECT 1')}],applied,r),/SOURCE/);
 assert.throws(()=>inspectReconstructionInventory(base,applied,r),/SOURCE/);
 for(const id of ['113_reconstruction_issue_history','116_case_export_retention']){const changed=inventory.map(row=>row.id===id?{...row,sql:row.sql+' ',checksum:reconstructionDigest(row.sql+' ')}:row);assert.throws(()=>inspectReconstructionInventory(changed,applied,r),/SOURCE/);}
 assert.throws(()=>inspectReconstructionInventory(inventory.map((row,i)=>i===0?{...row,sql:'changed'}:row),applied,r),/SOURCE/);
});
test('retains actual-role platform locking requirements and refuses unsafe preflight before any connection',async()=>{
 const r=review(),rows=[r.apiRole,r.workerRole].flatMap(role=>['platform_memberships','proofs'].map(table=>({role,table,allowed:true,grantable:false})));assert.equal(inspectReconstructionPlatformLocks(rows,r).columns.length,2);
 assert.throws(()=>inspectReconstructionPlatformLocks(rows.map((row,i)=>i===0?{...row,grantable:true}:row),r),/PLATFORM_LOCK_PRIVILEGES_REQUIRED/);
 await assert.rejects(runReconstructionPreflight('owner',{}),/PROCESS_ROLE_REQUIRED/);await assert.rejects(runReconstructionPreflight('api',{}),/REVIEW_BINDING_REQUIRED/);
 const current={...r,expiresAt:new Date(Date.now()+3600000).toISOString()},env={PACKPROOF_RECONSTRUCTION_V3_REVIEW_JSON:JSON.stringify(current),PACKPROOF_RECONSTRUCTION_V3_REVIEW_SHA256:reconstructionDigest(current),PACKPROOF_RELEASE_SHA:current.source,ECS_CONTAINER_METADATA_URI_V4:'https://169.254.170.2/v4/invalid'};await assert.rejects(runReconstructionPreflight('api',env),/TASK_METADATA_REQUIRED/);
 const source=await readFile(new URL('./reconstruction-v3-runtime-preflight.mjs',import.meta.url),'utf8');assert.match(source,/READ ONLY/);assert.match(source,/recordsMigrationInventory\(117\)/);assert.match(source,/throughMigration:117/);assert.doesNotMatch(source,/db\.query\(\s*['"`](?:INSERT|UPDATE|DELETE|CREATE|ALTER|GRANT)\b/);
});
