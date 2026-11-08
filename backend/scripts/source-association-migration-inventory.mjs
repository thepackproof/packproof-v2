// Read-only source preparation. Never migrates, grants roles or activates a cohort.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const manifest=JSON.parse(readFileSync(new URL('./source-association-migration-manifest.json',import.meta.url),'utf8'));
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const entries=rows=>rows.map(({id,checksum})=>({id,checksum})).sort((a,b)=>a.id.localeCompare(b.id));
export function inspectSourceAssociationInventory(inventory,applied,review){
 if(!/^[a-f0-9]{40}$/.test(review?.reviewedSourceCommit??'')||review.reviewedInventorySha256!==manifest.inventorySha256)throw Error('SOURCE_ASSOCIATION_REVIEW_REQUIRED');
 if(manifest.schema!=='packproof.source-association-migration-manifest/v1'||manifest.additions.length!==1||manifest.additions[0].id!=='109_source_associations')throw Error('SOURCE_ASSOCIATION_MANIFEST_INVALID');
 if(inventory.length!==manifest.sourceCount||new Set(inventory.map(r=>r.id)).size!==inventory.length||sha(entries(inventory))!==manifest.inventorySha256||inventory.some(r=>typeof r.sql!=='string'||sha(r.sql)!==r.checksum))throw Error('SOURCE_ASSOCIATION_SOURCE_MISMATCH');
 const addition=manifest.additions[0],previous=inventory.filter(r=>r.id!==addition.id);
 if(sha(entries(previous))!==manifest.predecessorInventorySha256||inventory.find(r=>r.id===addition.id)?.checksum!==addition.checksum)throw Error('SOURCE_ASSOCIATION_PREDECESSOR_MISMATCH');
 const expected=new Map(inventory.map(r=>[r.id,r.checksum]));
 if(![previous.length,inventory.length].includes(applied.length)||new Set(applied.map(r=>r.id)).size!==applied.length||applied.some(r=>expected.get(r.id)!==r.checksum)||sha(entries(applied.filter(r=>r.id!==addition.id)))!==manifest.predecessorInventorySha256)throw Error('SOURCE_ASSOCIATION_APPLIED_RECEIPTS_MISMATCH');
 return {schema:'packproof.source-association-schema-preparation/v1',source:review.reviewedSourceCommit,sourceCount:inventory.length,appliedCount:applied.length,pending:applied.length!==inventory.length,inventorySha256:manifest.inventorySha256,additions:manifest.additions,migrationApplied:false,rolesChanged:false,featureActivation:false};
}
