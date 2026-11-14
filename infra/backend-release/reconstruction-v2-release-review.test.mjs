import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {reconstructionDigest,validateReconstructionReview,inspectReconstructionInventory,validateReconstructionTaskMetadata,inspectReconstructionPlatformLocks} from './reconstruction-v2-release-review.mjs';
const now=new Date('2026-11-14T12:00:00Z');
const review=()=>({schema:'packproof.reconstruction-release-review/v2',source:'a'.repeat(40),apiRole:'recon_api',workerRole:'recon_worker',ownerRole:'recon_owner',inventorySha256:'b'.repeat(64),recordsMigrationSha256:'c'.repeat(64),target:{host:'isolated-restore.example.invalid',database:'reconstruction_test'},clusterArn:'arn:aws:ecs:us-east-1:123456789012:cluster/reconstruction',candidateImage:'123456789012.dkr.ecr.us-east-1.amazonaws.com/packproof@sha256:'+'d'.repeat(64),expiresAt:'2026-11-14T13:00:00Z',featureActivation:false,customerReleaseQualified:false});
test('requires exact source, target, distinct roles and unexpired explicit inspection review',()=>{const r=review(),hash=reconstructionDigest(r);assert.equal(validateReconstructionReview(r,hash,r.source,now),hash);for(const changed of [{...r,schema:'packproof.reconstruction-release-review/v1'},{...r,workerRole:r.apiRole},{...r,featureActivation:true},{...r,customerReleaseQualified:true},{...r,expiresAt:'2026-11-14T11:00:00Z'},{...r,target:{...r.target,host:'https://unreviewed/'}}])assert.throws(()=>validateReconstructionReview(changed,reconstructionDigest(changed),r.source,now),/^Error: RECONSTRUCTION_/);assert.throws(()=>validateReconstructionReview({...r,source:'e'.repeat(40)},hash,r.source,now),/BINDING/);});
test('accepts only frozen113 predecessor plus114–116 source bytes and complete applied receipts',async()=>{
 const directory=new URL('../../backend/migrations/',import.meta.url),files=(await readdir(directory)).filter(name=>name.endsWith('.sql')&&Number(name.slice(0,3))<=116).sort();
 const inventory=await Promise.all(files.map(async name=>{const sql=await readFile(new URL(name,directory),'utf8');return {id:name.slice(0,-4),sql,checksum:reconstructionDigest(sql)};}));
 const applied=inventory.map(({id,checksum})=>({id,checksum})),r={...review(),inventorySha256:reconstructionDigest(applied)};
 assert.equal(inspectReconstructionInventory(inventory,applied,r).sourceCount,115);
 assert.throws(()=>inspectReconstructionInventory(inventory,applied.slice(0,-1),r),/APPLIED/);
 assert.throws(()=>inspectReconstructionInventory([...inventory,{id:'117_unreviewed',sql:'SELECT 1',checksum:reconstructionDigest('SELECT 1')}],applied,r),/SOURCE/);
 assert.throws(()=>inspectReconstructionInventory(inventory.slice(0,-1),applied,r),/SOURCE/);
 const changed=inventory.map(row=>row.id==='113_reconstruction_issue_history'?{...row,sql:row.sql+' ',checksum:reconstructionDigest(row.sql+' ')}:row);
 assert.throws(()=>inspectReconstructionInventory(changed,applied,r),/SOURCE/);
 assert.throws(()=>inspectReconstructionInventory(inventory.map((row,i)=>i===0?{...row,sql:'changed'}:row),applied,r),/SOURCE/);
});
test('binds real ECS v4 image URI and manifest digest to the exact cluster',()=>{
 const r=review(),task={TaskARN:'arn:aws:ecs:us-east-1:123456789012:task/reconstruction/'+'a'.repeat(32)},container={Image:r.candidateImage,ImageID:r.candidateImage.split('@')[1]};
 assert.equal(validateReconstructionTaskMetadata(container,task,r).image,r.candidateImage);
 for(const changed of [{...container,ImageID:container.ImageID.replace('dddd','eeee')},{...container,ImageID:r.candidateImage},{...container,Image:r.candidateImage.replace('/packproof@','/other@')},{...container,Image:r.candidateImage.split('@')[0]+':latest'}])assert.throws(()=>validateReconstructionTaskMetadata(changed,task,r),/IMAGE_CLUSTER/);
 assert.throws(()=>validateReconstructionTaskMetadata(container,{TaskARN:task.TaskARN.replace('/reconstruction/','/other/')},r),/IMAGE_CLUSTER/);
});

test('requires separately reviewed actual-role membership and inherited Proof lock columns',()=>{
 const r=review(),rows=[r.apiRole,r.workerRole].flatMap(role=>['platform_memberships','proofs'].map(table=>({role,table,allowed:true,grantable:false})));
 assert.equal(inspectReconstructionPlatformLocks(rows,r).columns.length,2);
 for(const changed of [rows.slice(1),rows.map((row,i)=>i===0?{...row,allowed:false}:row),rows.map((row,i)=>i===3?{...row,grantable:true}:row),[...rows,rows[0]]])assert.throws(()=>inspectReconstructionPlatformLocks(changed,r),/PLATFORM_LOCK_PRIVILEGES_REQUIRED/);
});
