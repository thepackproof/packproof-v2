// Build only: preserves the deployed image except for its pure schema guard.
// Actual app compatibility on the upgraded restore is a separate required gate.
import {CONNECT_IMAGE_BASE} from './connect-image-builds.mjs';
import {zeroTouchImageBuildRequest,ZERO_TOUCH_IMAGE_SOURCE} from './zero-touch-image-build.mjs';

export const ROLLBACK_ADDITIONS=Object.freeze([
 Object.freeze({id:'108_record_agents',checksum:'65794164c6cd479a5921d0f1b7f4bc6585cbeca149657f2e156523553fc65f9f'}),
 Object.freeze({id:'109_source_associations',checksum:'92731eb1d01248da47870884958e0f1da8d096196b52e95a50313622206aada9'}),
]);
export function extendRollbackGuard(original){
 const anchor='export const FORWARD_COMPATIBLE_MIGRATIONS = Object.freeze([';
 if(typeof original!=='string'||original.split(anchor).length!==2||original.includes('108_record_agents')||original.includes('109_source_associations'))throw Error('ZERO_TOUCH_UNMODIFIED_BASE_GUARD_REQUIRED');
 return original.replace(anchor,anchor+'\n'+ROLLBACK_ADDITIONS.map(x=>'    Object.freeze('+JSON.stringify(x)+'),').join('\n'));
}

export function zeroTouchRollbackBuildRequest(input){
 const request=zeroTouchImageBuildRequest(input),spec=JSON.parse(request.buildspecOverride);
 const oldTag=`zero-touch-v1-${ZERO_TOUCH_IMAGE_SOURCE}`,tag=`zero-touch-rollback-v1-${ZERO_TOUCH_IMAGE_SOURCE}`;
 spec.phases.pre_build.commands=spec.phases.pre_build.commands.map(x=>x.replaceAll(oldTag,tag));
 spec.phases.pre_build.commands.push(`docker pull '${CONNECT_IMAGE_BASE.image}'`);
 const transform=`import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const ROLLBACK_ADDITIONS=${JSON.stringify(ROLLBACK_ADDITIONS)};
${extendRollbackGuard.toString()}
const original=readFileSync('/tmp/zero-touch-rollback/guard.js','utf8'),patched=extendRollbackGuard(original);
const before=await import('data:text/javascript;base64,'+Buffer.from(original).toString('base64'));
const after=await import('data:text/javascript;base64,'+Buffer.from(patched).toString('base64'));
if(JSON.stringify(after.FORWARD_COMPATIBLE_MIGRATIONS.slice(2))!==JSON.stringify(before.FORWARD_COMPATIBLE_MIGRATIONS))throw Error('ZERO_TOUCH_PRIOR_COMPATIBILITY_CHANGED');
for(const pin of ROLLBACK_ADDITIONS){
 if(before.isReviewedForwardCompatibleMigration(pin)||!after.isReviewedForwardCompatibleMigration(pin))throw Error('ZERO_TOUCH_EXACT_BRIDGE_REQUIRED');
 for(const invalid of [{...pin,checksum:null},{...pin,checksum:'0'.repeat(64)},{...pin,id:'110_unreviewed'}])if(after.isReviewedForwardCompatibleMigration(invalid))throw Error('ZERO_TOUCH_ROLLBACK_GUARD_TOO_BROAD');
}
writeFileSync('/tmp/zero-touch-rollback/guard.js',patched);
const hash=x=>createHash('sha256').update(x).digest('hex');
console.log(JSON.stringify({event:'zero_touch_rollback_guard_prepared',originalSha256:hash(original),patchedSha256:hash(patched),additions:ROLLBACK_ADDITIONS,databaseQualification:false}));`;
 const build=`mkdir /tmp/zero-touch-rollback
container=$(docker create '${CONNECT_IMAGE_BASE.image}')
docker cp "$container:/app/backend/dist/db/forward-compatible-migrations.js" /tmp/zero-touch-rollback/guard.js
docker rm "$container"
node --input-type=module <<'JS'
${transform}
JS
cat > /tmp/zero-touch-rollback/Dockerfile <<'DOCKERFILE'
FROM ${CONNECT_IMAGE_BASE.image}
COPY guard.js /app/backend/dist/db/forward-compatible-migrations.js
USER node
DOCKERFILE
docker build --label "org.opencontainers.image.revision=$REVIEWED_SOURCE_SHA" --label "packproof.release.profile=zero-touch-rollback-v1" --label "packproof.rollback.base=${CONNECT_IMAGE_BASE.image}" -t "$ECR:$IMAGE_TAG" /tmp/zero-touch-rollback`;
 const verify=`docker run --rm -i --entrypoint node "$ECR:$IMAGE_TAG" --input-type=module <<'JS'
import {migrationInventory} from './dist/db/migrate.js';
import {isReviewedForwardCompatibleMigration} from './dist/db/forward-compatible-migrations.js';
import {createHash} from 'node:crypto';
const rows=await migrationInventory(),inventory=rows.map(({id,checksum})=>({id,checksum}));
const sha256=createHash('sha256').update(JSON.stringify(inventory)).digest('hex');
if(process.getuid()===0||rows.length!==106||sha256!=='${CONNECT_IMAGE_BASE.inventorySha256}')throw Error('ZERO_TOUCH_ROLLBACK_ORIGINAL_INVENTORY_REQUIRED');
for(const pin of ${JSON.stringify(ROLLBACK_ADDITIONS)})if(!isReviewedForwardCompatibleMigration(pin)||rows.some(x=>x.id===pin.id))throw Error('ZERO_TOUCH_ROLLBACK_EXACT_ENVELOPE_REQUIRED');
console.log(JSON.stringify({event:'zero_touch_rollback_inventory_verified',sourceCount:rows.length,sha256,nonRoot:true,databaseQualification:false}));
JS
docker image inspect '${CONNECT_IMAGE_BASE.image}' "$ECR:$IMAGE_TAG" > /tmp/zero-touch-images.json
node --input-type=module <<'JS'
import {readFileSync} from 'node:fs';
const [base,candidate]=JSON.parse(readFileSync('/tmp/zero-touch-images.json','utf8'));
if(!base.RootFS?.Layers?.length||candidate.RootFS?.Layers?.length!==base.RootFS.Layers.length+1||base.RootFS.Layers.some((layer,index)=>candidate.RootFS.Layers[index]!==layer))throw Error('ZERO_TOUCH_ROLLBACK_BASE_LAYERS_CHANGED');
console.log(JSON.stringify({event:'zero_touch_rollback_layers_preserved',baseImage:'${CONNECT_IMAGE_BASE.image}',baseLayers:base.RootFS.Layers.length,extraFilesystemLayers:1,databaseQualification:false}));
JS`;
 spec.phases.build.commands=[build,verify];
 request.buildspecOverride=JSON.stringify(spec);
 request.environmentVariablesOverride=request.environmentVariablesOverride.map(x=>x.name==='IMAGE_TAG'?{...x,value:tag}:x);
 request.idempotencyToken=`zero-touch-rollback-v1-${ZERO_TOUCH_IMAGE_SOURCE}`;
 return request;
}
