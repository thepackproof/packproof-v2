// Patch only the vulnerable OS library in the already pinned application images.
// Source, migrations and installed Node packages remain byte-identical.
import {zeroTouchImageBuildRequest,ZERO_TOUCH_IMAGE_SOURCE} from './zero-touch-image-build.mjs';
export const SECURITY_BASES=Object.freeze({
 candidate:'sha256:edb5051c4dc1dbd09fee6fd69e00bb16f47645486570f4e76861000812c3df96',
 rollback:'sha256:f0caa6cd0a2720c05f3bd7debf3b5e74cf24b628f6225d766c141a75e7e8254b',
});
const repo='784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api';
export function zeroTouchSecurityBuildRequest(profile,input){
 if(!Object.hasOwn(SECURITY_BASES,profile))throw Error('ZERO_TOUCH_SECURITY_PROFILE_REQUIRED');
 const r=zeroTouchImageBuildRequest(input),spec=JSON.parse(r.buildspecOverride),base=repo+'@'+SECURITY_BASES[profile];
 const old=`zero-touch-v1-${ZERO_TOUCH_IMAGE_SOURCE}`,tag=`zero-touch-${profile}-zlib14-${ZERO_TOUCH_IMAGE_SOURCE}`;
 spec.phases.pre_build.commands=spec.phases.pre_build.commands.map(x=>x.replaceAll(old,tag));
 spec.phases.pre_build.commands.push(`docker pull '${base}'`);
 const inventory=`find dist migrations scripts node_modules -type f -exec sha256sum {} + | sort | sha256sum`;
 spec.phases.build.commands=[`mkdir /tmp/zero-touch-security-${profile}
cat > /tmp/zero-touch-security-${profile}/Dockerfile <<'DOCKERFILE'
FROM ${base}
USER root
RUN apk add --no-cache --upgrade 'zlib>=1.4-r0' && apk info --installed 'zlib>=1.4-r0'
USER node
DOCKERFILE
docker build --label 'packproof.release.profile=zero-touch-${profile}-zlib14' --label 'packproof.security.base=${base}' -t "$ECR:$IMAGE_TAG" /tmp/zero-touch-security-${profile}`,
`docker run --rm --entrypoint sh '${base}' -c '${inventory}' > /tmp/zero-touch-before.sha256
docker run --rm --entrypoint sh "$ECR:$IMAGE_TAG" -c '${inventory}' > /tmp/zero-touch-after.sha256
cmp /tmp/zero-touch-before.sha256 /tmp/zero-touch-after.sha256
docker run --rm --entrypoint sh "$ECR:$IMAGE_TAG" -c 'test "$(id -u)" != 0 && apk info --installed "zlib>=1.4-r0" && ffmpeg -version && ffprobe -version && command -v prlimit'
docker image inspect '${base}' "$ECR:$IMAGE_TAG" > /tmp/zero-touch-security-images.json
node --input-type=module <<'JS'
import {readFileSync} from 'node:fs';
const [base,candidate]=JSON.parse(readFileSync('/tmp/zero-touch-security-images.json','utf8'));
if(!base.RootFS?.Layers?.length||candidate.RootFS?.Layers?.length!==base.RootFS.Layers.length+1||base.RootFS.Layers.some((layer,index)=>candidate.RootFS.Layers[index]!==layer))throw Error('ZERO_TOUCH_SECURITY_BASE_CHANGED');
console.log(JSON.stringify({event:'zero_touch_security_image_verified',profile:'${profile}',baseImage:'${base}',baseLayers:base.RootFS.Layers.length,extraFilesystemLayers:1,applicationBytesPreserved:true,zlibMinimum:'1.4-r0',databaseQualification:false}));
JS`];
 r.buildspecOverride=JSON.stringify(spec);
 r.environmentVariablesOverride=r.environmentVariablesOverride.map(x=>x.name==='IMAGE_TAG'?{...x,value:tag}:x);
 r.idempotencyToken=`zt-${profile}-z14-${ZERO_TOUCH_IMAGE_SOURCE}`;
 return r;
}
