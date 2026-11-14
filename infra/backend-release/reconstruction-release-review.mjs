// Pure candidate-source and review validation. Does not open a database, apply
// migrations, grant roles, activate a source, or establish installed acceptance.
import {createHash} from 'node:crypto';
export const reconstructionDigest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const fail=code=>{throw Error(code);};
const hex=(value,length)=>typeof value==='string'&&new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const entries=rows=>rows.map(({id,checksum})=>({id,checksum})).sort((a,b)=>a.id.localeCompare(b.id));
const predecessor='a873b3f50dc1d4a380067d4a3d1a642472827df2fb2e99634ac3b45aa6260a6d';
const additions=['110_existing_data_reconstruction','111_source_subscriptions','112_reconstruction_exports','113_reconstruction_issue_history'];
export function validateReconstructionReview(review,expectedHash,source,now=new Date()) {
 if(review?.schema!=='packproof.reconstruction-release-review/v1'||!hex(source,40)||review.source!==source||reconstructionDigest(review)!==expectedHash||!hex(review.inventorySha256,64)||!hex(review.recordsMigrationSha256,64))fail('RECONSTRUCTION_REVIEW_BINDING_REQUIRED');
 if(![review.apiRole,review.workerRole,review.ownerRole].every(role=>typeof role==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(role)&&!role.startsWith('pg_'))||new Set([review.apiRole,review.workerRole,review.ownerRole]).size!==3)fail('RECONSTRUCTION_DISTINCT_ROLES_REQUIRED');
 if(!/^[a-zA-Z0-9.-]+$/.test(review.target?.host??'')||!review.target.host.includes('.')||!/^[a-zA-Z0-9_]{1,63}$/.test(review.target?.database??'')||!/^arn:aws:ecs:[a-z0-9-]+:[0-9]{12}:cluster\/[a-zA-Z0-9_-]+$/.test(review.clusterArn??'')||!/^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-zA-Z0-9_./-]+@sha256:[a-f0-9]{64}$/.test(review.candidateImage??''))fail('RECONSTRUCTION_REVIEW_TARGET_REQUIRED');
 const remaining=Date.parse(review.expiresAt)-now.getTime();if(!Number.isFinite(remaining)||remaining<=0||remaining>86400000)fail('RECONSTRUCTION_REVIEW_EXPIRED');
 if(review.featureActivation!==false||review.customerReleaseQualified!==false)fail('RECONSTRUCTION_PREFLIGHT_IS_NOT_RELEASE_APPROVAL');
 return expectedHash;
}
export function inspectReconstructionInventory(inventory,applied,review) {
 const normalized=entries(inventory),base=normalized.filter(row=>!additions.includes(row.id));
 if(inventory.length!==112||new Set(inventory.map(row=>row.id)).size!==112||additions.some(id=>!inventory.some(row=>row.id===id))||reconstructionDigest(base)!==predecessor||reconstructionDigest(normalized)!==review.inventorySha256||inventory.some(row=>typeof row.sql!=='string'||reconstructionDigest(row.sql)!==row.checksum))fail('RECONSTRUCTION_SOURCE_INVENTORY_MISMATCH');
 if(applied.length!==normalized.length||new Set(applied.map(row=>row.id)).size!==applied.length||reconstructionDigest(entries(applied))!==review.inventorySha256)fail('RECONSTRUCTION_APPLIED_INVENTORY_MISMATCH');
 return {sourceCount:normalized.length,appliedCount:applied.length,inventorySha256:review.inventorySha256,additions:additions.map(id=>normalized.find(row=>row.id===id)),migrationsApplied:false,rolesChanged:false,featureActivation:false};
}
export function validateReconstructionTaskMetadata(container,task,review) {
 const prefix=review.clusterArn.replace(':cluster/',':task/')+'/';
 if(container?.ImageID!==review.candidateImage||!task?.TaskARN?.startsWith(prefix)||!/^[a-f0-9]{32}$/.test(task.TaskARN.slice(prefix.length)))fail('RECONSTRUCTION_ACTUAL_TASK_IMAGE_CLUSTER_MISMATCH');
 return {taskArn:task.TaskARN,image:container.ImageID};
}
