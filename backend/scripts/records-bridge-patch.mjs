import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

// Measured from the immutable live image in the stopped, exit-zero source-pin
// task 9f48bb86c74c4624a8229bfc3734dcaa. No other application bytes are replaced.
export const BASE_MODULE_SHA256='55a4f5d0b9bd1830b63464f81de008681b507a103385b8d0a98de2f0c61a2a8f';
export const BASE_IMAGE='784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api@sha256:434f5cd40bf365a6bdf585fa6302f786ea4571dda892fd761c3dbd85d6b5aa54';
const hash=value=>createHash('sha256').update(value).digest('hex');
export function extendForwardCompatibility(original,manifest){
 if(hash(original)!==BASE_MODULE_SHA256)throw Error('RECORDS_BRIDGE_BASE_BYTES_MISMATCH');
 if(manifest.schema!=='packproof.records-migration-manifest/v1'||manifest.inventorySha256!=='605ba38f1c9ffcd6dd28a64a7d07d9cc41c3397ee7c10ba26198ad14ec50c2e1'||manifest.additions?.length!==12||hash(JSON.stringify(manifest.additions))!=='1f1e4946690eae315c8d017bca1d9af177797ff062485b5b7827c9fa3f7baeb3')throw Error('RECORDS_BRIDGE_MANIFEST_MISMATCH');
 const anchor='export const FORWARD_COMPATIBLE_MIGRATIONS = Object.freeze([';
 if(original.split(anchor).length!==2||manifest.additions.some(row=>!/^((09[6-9])|(10[0-7]))_[a-z0-9_]+$/.test(row.id)||!/^[a-f0-9]{64}$/.test(row.checksum)))throw Error('RECORDS_BRIDGE_MODULE_SHAPE_MISMATCH');
 const insertion=manifest.additions.map(row=>'\n    Object.freeze('+JSON.stringify(row)+'),').join('');
 return original.replace(anchor,anchor+insertion);
}
export async function run(target,manifestFile){
 if(target!=='/app/backend/dist/db/forward-compatible-migrations.js')throw Error('RECORDS_BRIDGE_TARGET_MISMATCH');
 const original=await readFile(target,'utf8'),manifest=JSON.parse(await readFile(manifestFile,'utf8'));
 const patched=extendForwardCompatibility(original,manifest);
 await writeFile(target,patched,{flag:'r+'});
 const actual=await readFile(target,'utf8');if(actual!==patched)throw Error('RECORDS_BRIDGE_WRITE_MISMATCH');
 const mod=await import(pathToFileURL(target).href);
 for(const row of manifest.additions)if(!mod.isReviewedForwardCompatibleMigration(row)||mod.isReviewedForwardCompatibleMigration({...row,checksum:'0'.repeat(64)}))throw Error('RECORDS_BRIDGE_PIN_ADMISSION_MISMATCH');
 console.log(JSON.stringify({event:'records_bridge_module_verified',baseImage:BASE_IMAGE,baseModuleSha256:BASE_MODULE_SHA256,patchedModuleSha256:hash(actual),inventorySha256:manifest.inventorySha256,additions:manifest.additions.length,otherApplicationBytesChanged:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)run(...process.argv.slice(2)).catch(()=>{console.error('RECORDS_BRIDGE_BUILD_FAILED');process.exitCode=1;});
