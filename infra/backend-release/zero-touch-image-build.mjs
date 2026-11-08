// Image preparation only. Never applies SQL, grants authority or deploys a service.
import {buildRequest} from './backend-release-requests.mjs';
import {CONNECT_IMAGE_BASE} from './connect-image-builds.mjs';

export const ZERO_TOUCH_IMAGE_SOURCE='3bff0173c9d91fc11ae614d72872b877628c327d';
export const ZERO_TOUCH_ARCHIVE_SHA256='656cf424bb93de9dc76d9141c5a4f38107a6ae29849accc0f87519a3cf8b2e83';
const inventorySha256='a873b3f50dc1d4a380067d4a3d1a642472827df2fb2e99634ac3b45aa6260a6d';
const repository='784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api';

export function zeroTouchImageBuildRequest({sourceSha,zipSha256,sourceVersion}){
 if(sourceSha!==ZERO_TOUCH_IMAGE_SOURCE||zipSha256!==ZERO_TOUCH_ARCHIVE_SHA256||sourceVersion!==undefined&&(typeof sourceVersion!=='string'||!sourceVersion||sourceVersion==='null'))throw Error('ZERO_TOUCH_EXACT_REVIEWED_ARCHIVE_REQUIRED');
 const retention=`aws ecr get-lifecycle-policy --repository-name packproof-v2-staging-api --output json > /tmp/retention.json
aws ecr describe-images --repository-name packproof-v2-staging-api --output json > /tmp/images.json
node --input-type=module <<'JS'
import {readFileSync} from 'node:fs';
const policy=JSON.parse(JSON.parse(readFileSync('/tmp/retention.json','utf8')).lifecyclePolicyText);
const images=JSON.parse(readFileSync('/tmp/images.json','utf8')).imageDetails.sort((a,b)=>Date.parse(b.imagePushedAt)-Date.parse(a.imagePushedAt));
const position=images.findIndex(row=>row.imageDigest==='${CONNECT_IMAGE_BASE.image.split('@')[1]}'),rule=policy.rules?.[0];
if(policy.rules?.length!==1||rule.selection?.tagStatus!=='any'||rule.selection?.countType!=='imageCountMoreThan'||rule.action?.type!=='expire'||position<0||rule.selection.countNumber<position+3)throw Error('ZERO_TOUCH_BASE_RETENTION_REQUIRED');
if(images.some(row=>row.imageTags?.includes(process.env.IMAGE_TAG)))throw Error('ZERO_TOUCH_IMAGE_TAG_ALREADY_EXISTS');
JS`;
 const verify=`docker run --rm -i --entrypoint node "$ECR:$IMAGE_TAG" --input-type=module <<'JS'
import {readFile} from 'node:fs/promises';
import {migrationInventory} from './dist/db/migrate.js';
import {inspectSourceAssociationInventory} from './scripts/source-association-migration-inventory.mjs';
const rows=await migrationInventory();
if(process.getuid()===0||rows.length!==108)throw Error('ZERO_TOUCH_IMAGE_RUNTIME_MISMATCH');
const receipt=inspectSourceAssociationInventory(rows,rows,{reviewedSourceCommit:'${ZERO_TOUCH_IMAGE_SOURCE}',reviewedInventorySha256:'${inventorySha256}'});
await readFile('certs/rds-us-east-1-bundle.pem');
console.log(JSON.stringify({event:'zero_touch_image_source_verified',...receipt,nonRoot:true,databaseQualification:false}));
JS`;
 const buildspec=JSON.stringify({version:'0.2',phases:{pre_build:{'on-failure':'ABORT',commands:[
  'test "$AWS_DEFAULT_REGION" = us-east-1',
  'test "$(aws sts get-caller-identity --query Account --output text)" = 784514617543',
  `test "$REVIEWED_SOURCE_SHA" = '${ZERO_TOUCH_IMAGE_SOURCE}'`,
  `test "$IMAGE_TAG" = 'zero-touch-v1-${ZERO_TOUCH_IMAGE_SOURCE}'`,
  `ECR=${repository}`,'export ECR',retention,
  // The existing source bucket is unversioned. Re-fetch, hash and unpack into
  // an empty context before building, so initial CodeBuild extraction is never trusted.
  'if [ -n "$SOURCE_OBJECT_VERSION" ]; then aws s3api get-object --bucket packproof-v2-staging-build-784514617543 --key "security-release/$REVIEWED_SOURCE_SHA/'+ZERO_TOUCH_ARCHIVE_SHA256+'/backend.zip" --version-id "$SOURCE_OBJECT_VERSION" /tmp/reviewed-source.zip; else aws s3api get-object --bucket packproof-v2-staging-build-784514617543 --key "security-release/$REVIEWED_SOURCE_SHA/'+ZERO_TOUCH_ARCHIVE_SHA256+'/backend.zip" /tmp/reviewed-source.zip; fi',
  `echo '${ZERO_TOUCH_ARCHIVE_SHA256}  /tmp/reviewed-source.zip' | sha256sum --check -`,
  'mkdir /tmp/zero-touch-reviewed && python3 -m zipfile -e /tmp/reviewed-source.zip /tmp/zero-touch-reviewed',
  'aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 784514617543.dkr.ecr.us-east-1.amazonaws.com',
 ]},build:{'on-failure':'ABORT',commands:[
  'cd /tmp/zero-touch-reviewed',
  'docker build --label "org.opencontainers.image.revision=$REVIEWED_SOURCE_SHA" --label "packproof.release.profile=zero-touch-v1" -t "$ECR:$IMAGE_TAG" -f backend/Dockerfile .',verify,
  'docker run --rm --entrypoint sh "$ECR:$IMAGE_TAG" -c \'command -v ffmpeg && command -v ffprobe && command -v prlimit && apk info --installed "zlib>=1.3.2-r1"\'',
 ]},post_build:{'on-failure':'ABORT',commands:[
  'test "$CODEBUILD_BUILD_SUCCEEDING" = 1','docker push "$ECR:$IMAGE_TAG"',
  'aws ecr batch-get-image --repository-name packproof-v2-staging-api --image-ids "imageTag=$IMAGE_TAG" --query "images[].imageId" --output json',
 ]}}});
 const request=buildRequest({sourceSha,zipSha256,sourceVersion,buildspec});
 request.environmentVariablesOverride=request.environmentVariablesOverride.map(row=>row.name==='IMAGE_TAG'?{...row,value:`zero-touch-v1-${sourceSha}`}:row);
 request.environmentVariablesOverride.push({name:'SOURCE_OBJECT_VERSION',value:sourceVersion??'',type:'PLAINTEXT'});
 return {...request,timeoutInMinutesOverride:30,queuedTimeoutInMinutesOverride:5,idempotencyToken:`zero-touch-v1-${sourceSha}-r2`};
}
