// Image preparation only. These requests never migrate, deploy, enable a
// feature, modify the CodeBuild project or claim database qualification.
import {buildRequest} from './backend-release-requests.mjs';

export const CONNECT_IMAGE_BASE=Object.freeze({
 source:'e346452ade2744820fb2f429d7aeb94fef376419',
 image:'784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api@sha256:d1775ac9ff380b7364814ed1ad7504c8eef6e82484f686d9e381dcf16c816ff0',
 inventorySha256:'605ba38f1c9ffcd6dd28a64a7d07d9cc41c3397ee7c10ba26198ad14ec50c2e1',
});
export const CONNECT_IMAGE_INVENTORY=Object.freeze({
 count:107,sha256:'ac0f0b11921f57e6dffeba0561c3e8e0991e63f9b6eaa1870ce5c7246d5a5921',
 addition:Object.freeze({id:'108_record_agents',checksum:'65794164c6cd479a5921d0f1b7f4bc6585cbeca149657f2e156523553fc65f9f'}),
});
const repository='784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api';
const check=(value,code)=>{if(!value)throw Error(code);};

// The compiler stage may install build dependencies. The released stage keeps
// the measured immutable production filesystem and copies one pure guard file.
// Its migrations remain the original106 files; no migration operator is run.
export const CONNECT_ROLLBACK_DOCKERFILE=`FROM ${CONNECT_IMAGE_BASE.image} AS guard-build
USER root
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --include=dev
COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/scripts/m2-runtime-privileges.mjs backend/scripts/m2-runtime-privileges.d.mts ./scripts/
COPY packages/evidence-contracts /app/packages/evidence-contracts
RUN npm run build
FROM ${CONNECT_IMAGE_BASE.image}
COPY --from=guard-build /app/backend/dist/db/forward-compatible-migrations.js /app/backend/dist/db/forward-compatible-migrations.js
USER node
`;

function verification(profile){
 const rollback=profile==='rollback';
 return `import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {migrationInventory} from './dist/db/migrate.js';
${rollback?"import {isReviewedForwardCompatibleMigration} from './dist/db/forward-compatible-migrations.js';":"import {inspectAgentMigrationInventory} from './scripts/record-agent-migration-inventory.mjs';"}
const rows=await migrationInventory(),inventory=rows.map(({id,checksum})=>({id,checksum}));
const inventorySha256=createHash('sha256').update(JSON.stringify(inventory)).digest('hex');
if(process.getuid()===0||rows.length!==${rollback?106:CONNECT_IMAGE_INVENTORY.count}||inventorySha256!=='${rollback?CONNECT_IMAGE_BASE.inventorySha256:CONNECT_IMAGE_INVENTORY.sha256}')throw Error('CONNECT_IMAGE_INVENTORY_MISMATCH');
${rollback?`const pin=${JSON.stringify(CONNECT_IMAGE_INVENTORY.addition)};
if(rows.some(row=>row.id===pin.id)||!isReviewedForwardCompatibleMigration(pin)||isReviewedForwardCompatibleMigration({...pin,checksum:null})||isReviewedForwardCompatibleMigration({...pin,checksum:'0'.repeat(64)})||isReviewedForwardCompatibleMigration({...pin,id:'109_unreviewed'}))throw Error('CONNECT_ROLLBACK_EXACT_GUARD_REQUIRED');`:`inspectAgentMigrationInventory(rows,rows,{reviewedSourceCommit:process.env.REVIEWED_SOURCE_SHA,reviewedInventorySha256:'${CONNECT_IMAGE_INVENTORY.sha256}'});
for(const file of ['scripts/record-agent-migrate-cli.mjs','scripts/record-agent-migrate.mjs','scripts/record-agent-schema.mjs','scripts/record-agent-schema-manifest.json','/release/record-agent-database-preflight.mjs','/release/record-agent-previous-image-probe.mjs'])await readFile(file);`}
await readFile('certs/rds-us-east-1-bundle.pem');
console.log(JSON.stringify({event:'connect_image_source_verified',profile:'${profile}',source:process.env.REVIEWED_SOURCE_SHA,nonRoot:true,sourceCount:rows.length,inventorySha256,databaseQualification:false}));`;
}

export function connectBuildspec(profile){
 check(['candidate','rollback'].includes(profile),'CONNECT_IMAGE_PROFILE_REQUIRED');
 const rollback=profile==='rollback',prefix=rollback?'connect-rollback-':'connect-v1-';
 const dockerfile=rollback?`cat > /tmp/connect-rollback.Dockerfile <<'DOCKERFILE'\n${CONNECT_ROLLBACK_DOCKERFILE}DOCKERFILE\ndocker build --label "org.opencontainers.image.revision=$REVIEWED_SOURCE_SHA" --label "packproof.release.profile=connect-rollback-v1" --label "packproof.rollback.base=${CONNECT_IMAGE_BASE.image}" -t "$ECR:$IMAGE_TAG" -f /tmp/connect-rollback.Dockerfile .`:`docker build --label "org.opencontainers.image.revision=$REVIEWED_SOURCE_SHA" --label "packproof.release.profile=connect-v1" -t "$ECR:$IMAGE_TAG" -f backend/Dockerfile .`;
 const verify=`docker run --rm -i -e REVIEWED_SOURCE_SHA="$REVIEWED_SOURCE_SHA" --entrypoint node "$ECR:$IMAGE_TAG" --input-type=module <<'JS'\n${verification(profile)}\nJS`;
 const provenance=rollback?`docker image inspect '${CONNECT_IMAGE_BASE.image}' "$ECR:$IMAGE_TAG" > /tmp/connect-images.json\nnode --input-type=module <<'JS'\nimport {readFileSync} from 'node:fs';\nconst [base,candidate]=JSON.parse(readFileSync('/tmp/connect-images.json','utf8'));\nif(!base.RootFS?.Layers?.length||candidate.RootFS?.Layers?.length!==base.RootFS.Layers.length+1||base.RootFS.Layers.some((layer,index)=>candidate.RootFS.Layers[index]!==layer))throw Error('CONNECT_ROLLBACK_IMMUTABLE_BASE_REQUIRED');\nconsole.log(JSON.stringify({event:'connect_rollback_base_layers_preserved',baseImage:'${CONNECT_IMAGE_BASE.image}',baseLayers:base.RootFS.Layers.length,extraFilesystemLayers:1,databaseQualification:false}));\nJS`:undefined;
 const commands=[dockerfile,verify,...(provenance?[provenance]:[]),`docker run --rm --entrypoint sh "$ECR:$IMAGE_TAG" -c 'command -v ffmpeg && command -v ffprobe && command -v prlimit && apk info --installed "zlib>=1.3.2-r1"'`];
 const retention=`aws ecr get-lifecycle-policy --repository-name packproof-v2-staging-api --output json > /tmp/connect-retention.json
aws ecr describe-images --repository-name packproof-v2-staging-api --output json > /tmp/connect-retained-images.json
node --input-type=module <<'JS'
import {readFileSync} from 'node:fs';
const policy=JSON.parse(JSON.parse(readFileSync('/tmp/connect-retention.json','utf8')).lifecyclePolicyText);
const images=JSON.parse(readFileSync('/tmp/connect-retained-images.json','utf8')).imageDetails.sort((a,b)=>Date.parse(b.imagePushedAt)-Date.parse(a.imagePushedAt));
const position=images.findIndex(row=>row.imageDigest==='${CONNECT_IMAGE_BASE.image.split('@')[1]}'),rule=policy.rules?.[0];
if(policy.rules?.length!==1||rule.selection?.tagStatus!=='any'||rule.selection?.countType!=='imageCountMoreThan'||rule.action?.type!=='expire'||position<0||rule.selection.countNumber<position+3)throw Error('CONNECT_BASE_RETENTION_REVIEW_REQUIRED');
if(images.some(row=>row.imageTags?.includes(process.env.IMAGE_TAG)))throw Error('CONNECT_IMAGE_TAG_ALREADY_EXISTS');
JS`;
 // JSON is a supported CodeBuild buildspec format and preserves heredocs exactly.
 return JSON.stringify({version:'0.2',phases:{pre_build:{'on-failure':'ABORT',commands:[
  'test "$AWS_DEFAULT_REGION" = us-east-1',
  'test "$(aws sts get-caller-identity --query Account --output text)" = 784514617543',
  'printf "%s" "$REVIEWED_SOURCE_SHA" | grep -Eq "^[a-f0-9]{40}$"',
  `test "$IMAGE_TAG" = "${prefix}$REVIEWED_SOURCE_SHA"`,
  'test -f backend/Dockerfile && test -f backend/src/index.ts && test -f packages/evidence-contracts/package.json && test -f config/rnd/research-build.json',
  ...(rollback?[]:['test -f infra/backend-release/record-agent-database-preflight.mjs && test -f infra/backend-release/record-agent-previous-image-probe.mjs']),
  `ECR=${repository}`,'export ECR',
  retention,
  'aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 784514617543.dkr.ecr.us-east-1.amazonaws.com',
  ...(rollback?[`docker pull '${CONNECT_IMAGE_BASE.image}'`]:[]),
 ]},build:{'on-failure':'ABORT',commands},post_build:{'on-failure':'ABORT',commands:[
  'test "$CODEBUILD_BUILD_SUCCEEDING" = 1',
  'docker push "$ECR:$IMAGE_TAG"',
  'aws ecr batch-get-image --region us-east-1 --repository-name packproof-v2-staging-api --image-ids "imageTag=$IMAGE_TAG" --query "images[].imageId" --output json',
 ]}}});
}

/** Use backend-source-archive.py <sha> <zip> connect-v1 for the candidate,
 * records-v1 for the older rollback source, then repeat with --verify.
 * Upload to the returned unique source key and verify the actual S3 checksum,
 * size and version before starting this request. Archive metadata is public.
 * The rollback source must be reviewed as exactly the production base plus the
 * guard/test patch; its actual restored-DB probe remains an independent gate.
 */
export function connectImageBuildRequest({profile,sourceSha,zipSha256,sourceVersion}){
 check(['candidate','rollback'].includes(profile),'CONNECT_IMAGE_PROFILE_REQUIRED');
 const request=buildRequest({sourceSha,zipSha256,sourceVersion,buildspec:connectBuildspec(profile)});
 request.environmentVariablesOverride=request.environmentVariablesOverride.map(item=>item.name==='IMAGE_TAG'?{...item,value:`${profile==='rollback'?'connect-rollback-':'connect-v1-'}${sourceSha}`}:item);
 return request;
}
