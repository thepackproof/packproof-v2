import { pathToFileURL } from 'node:url';
import { buildRequest } from './backend-release-requests.mjs';
import { hostedCollectorTarget } from './reconstruction-v11-release-review.mjs';
import { inventorySha256, previousInventorySha256 } from '../../backend/scripts/logistics-forward-guard.mjs';

const repository = hostedCollectorTarget.repository;
const account = repository.split('.')[0];
const repositoryName = repository.split('/')[1];
const shell = script => "node --input-type=module <<'JS'\n" + script + "\nJS";

export function prepareLogisticsImages({source, archiveSha256, sourceVersion, predecessorImage}) {
  if (!/^[a-f0-9]{40}$/.test(source ?? '') || !/^[a-f0-9]{64}$/.test(archiveSha256 ?? '') ||
      !/^[a-zA-Z0-9_.+\/=\-]{1,1024}$/.test(sourceVersion ?? '') || sourceVersion === 'null' ||
      !predecessorImage?.startsWith(repository+'@sha256:') ||
      !/^[a-f0-9]{64}$/.test(predecessorImage.slice((repository+'@sha256:').length)))
    throw Error('A reviewed source, versioned source archive and exact hosted predecessor digest are required.');
  const receipt = {schema:'packproof.logistics-images/v1', source, predecessorImage,
    candidateTag:'logistics-v1-'+source, fallbackTag:'logistics-compat-'+source,
    inventorySha256, previousInventorySha256};
  const key = 'security-release/'+source+'/'+archiveSha256+'/backend.zip';
  const pre = [
    'test "$AWS_DEFAULT_REGION" = us-east-1',
    'test "$(aws sts get-caller-identity --query Account --output text)" = '+account,
    'aws s3api get-object --bucket packproof-v2-staging-build-'+account+' --key '+key+' --version-id "$ARCHIVE_VERSION" /tmp/logistics-input.zip >/dev/null',
    "echo '"+archiveSha256+"  /tmp/logistics-input.zip' | sha256sum -c -",
    'aws ecr get-lifecycle-policy --repository-name '+repositoryName+' > /tmp/logistics-policy.json',
    'aws ecr describe-images --repository-name '+repositoryName+' > /tmp/logistics-images.json',
    shell(`import {readFileSync,writeFileSync} from 'node:fs';
const policy=JSON.parse(JSON.parse(readFileSync('/tmp/logistics-policy.json','utf8')).lifecyclePolicyText);
const images=JSON.parse(readFileSync('/tmp/logistics-images.json','utf8')).imageDetails.sort((a,b)=>Date.parse(b.imagePushedAt)-Date.parse(a.imagePushedAt));
const [rule]=policy.rules;
const rank=images.findIndex(i=>i.imageDigest===${JSON.stringify(predecessorImage.split('@')[1])});
if(policy.rules.length!==1 || rule.selection?.tagStatus!=='any' || rule.selection?.countType!=='imageCountMoreThan' || rule.action?.type!=='expire' ||
   rank<0 || rank+3>rule.selection.countNumber) throw Error('Both new images and the predecessor must fit the retention policy.');
for(const [name,tag] of [['candidate',process.env.CANDIDATE_TAG],['fallback',process.env.FALLBACK_TAG]]) {
 const found=images.filter(i=>i.imageTags?.includes(tag));
 if(found.length>1 || (found.length && !/^sha256:[a-f0-9]{64}$/.test(found[0].imageDigest))) throw Error('Ambiguous existing release image.');
 if(found.length) writeFileSync('/tmp/logistics-'+name+'.digest',found[0].imageDigest);
}`),
    'aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin '+repository.split('/')[0],
    'docker pull "$PREDECESSOR"',
  ];
  const image = repository+':';
  const labels = '--label org.opencontainers.image.revision="$REVIEWED_SOURCE_SHA" --label io.packproof.archive.sha256='+archiveSha256+' --label io.packproof.reviewed-predecessor="$PREDECESSOR"';
  const reuse = (kind,tag,command) => 'if test -f /tmp/logistics-'+kind+'.digest; then old='+repository+'@"$(cat /tmp/logistics-'+kind+'.digest)"; docker pull "$old" && docker tag "$old" '+image+tag+'; else '+command+'; fi';
  const build = [
    reuse('candidate','"$CANDIDATE_TAG"',
      'docker build -f backend/Dockerfile -t local-logistics-runtime:"$REVIEWED_SOURCE_SHA" . && docker build --build-arg CANDIDATE_BASE=local-logistics-runtime:"$REVIEWED_SOURCE_SHA" '+labels+' -f backend/Dockerfile.logistics-candidate -t '+image+'"$CANDIDATE_TAG" .'),
    reuse('fallback','"$FALLBACK_TAG"',
      'docker build --build-arg PREDECESSOR_IMAGE="$PREDECESSOR" '+labels+' -f backend/Dockerfile.logistics-fallback -t '+image+'"$FALLBACK_TAG" .'),
    ...['"$CANDIDATE_TAG"','"$FALLBACK_TAG"'].map(tag=>'test "$(docker image inspect --format \'{{index .Config.Labels "org.opencontainers.image.revision"}}\' '+image+tag+')" = "$REVIEWED_SOURCE_SHA" && test "$(docker image inspect --format \'{{index .Config.Labels "io.packproof.archive.sha256"}}\' '+image+tag+')" = '+archiveSha256+' && test "$(docker image inspect --format \'{{index .Config.Labels "io.packproof.reviewed-predecessor"}}\' '+image+tag+')" = "$PREDECESSOR"'),
    'node backend/scripts/verify-logistics-images.mjs "$PREDECESSOR" '+image+'"$CANDIDATE_TAG" '+image+'"$FALLBACK_TAG"',
  ];
  const publish = [
    'test "$CODEBUILD_BUILD_SUCCEEDING" = 1',
    'test -f /tmp/logistics-fallback.digest || docker push '+image+'"$FALLBACK_TAG"',
    'test -f /tmp/logistics-candidate.digest || docker push '+image+'"$CANDIDATE_TAG"',
    'aws ecr describe-images --repository-name '+repositoryName+' --image-ids imageTag="$CANDIDATE_TAG" imageTag="$FALLBACK_TAG"',
    shell('console.log(JSON.stringify('+JSON.stringify(receipt)+'))'),
  ];
  const phase = commands => ({'on-failure':'ABORT',commands});
  const request = buildRequest({sourceSha:source,zipSha256:archiveSha256,sourceVersion,
    buildspec:JSON.stringify({version:'0.2',phases:{pre_build:phase(pre),build:phase(build),post_build:phase(publish)}})});
  request.environmentVariablesOverride = Object.entries({REVIEWED_SOURCE_SHA:source, ARCHIVE_VERSION:sourceVersion,
    PREDECESSOR:predecessorImage, CANDIDATE_TAG:receipt.candidateTag, FALLBACK_TAG:receipt.fallbackTag})
    .map(([name,value])=>({name,value,type:'PLAINTEXT'}));
  return {request,receipt};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source,archiveSha256,sourceVersion,predecessorImage] = process.argv.slice(2);
  if (process.argv.length !== 6) throw Error('Usage: logistics-image-builds.mjs SOURCE ARCHIVE_SHA256 S3_VERSION PRIOR_ECR_IMAGE');
  console.log(JSON.stringify(prepareLogisticsImages({source,archiveSha256,sourceVersion,predecessorImage}),null,2));
}
