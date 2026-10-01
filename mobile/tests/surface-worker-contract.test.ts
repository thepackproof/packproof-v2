/** Generated JPEG protocol fixture. This test does not measure physical accuracy. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, sourceRegions, sourceBarcodePolygon, type SurfaceSource } from '../src/fingerprint/model.ts';
const exec=promisify(execFile);
const worker=fileURLToPath(new URL('../../surface-worker/',import.meta.url));
const python=process.env.PACKPROOF_SURFACE_PYTHON??join(worker,'.venv/bin/python');
test('native source dimensions, rotated barcode and full context polygons pass actual Python extraction', {skip:!existsSync(python)}, async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-surface-contract-'));
  try{
    await exec(python,['-c',`import cv2,numpy as np,sys
rng=np.random.default_rng(9)
im=np.clip(rng.normal(140,40,(720,1280)),15,235).astype('uint8')
assert cv2.imwrite(sys.argv[1],im,[cv2.IMWRITE_JPEG_QUALITY,95])`,join(directory,'surface-original-0.jpg')],{env:{...process.env,OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'}});
    const bytes=await readFile(join(directory,'surface-original-0.jpg'));
    const source:SurfaceSource={fileName:'surface-original-0.jpg',sha256:digest(bytes),byteSize:bytes.length,width:1280,height:720,rotationDegrees:90,frameTimeMs:3200,barcodeBounds:[120,240,540,1020]};
    const regions=sourceRegions('native_frame_0',0,source);
    assert.deepEqual(regions[0].polygon,[[0,0],[1279,0],[1279,719],[0,719]]);
    const capture={captureProfileId:'android-analysis-v1-unqualified',acquisition:'live',sources:[{sourceId:'native_frame_0',mediaPath:source.fileName,sha256:source.sha256,frameTimeMs:source.frameTimeMs}],regions,
      hints:[{sourceId:'native_frame_0',barcodePolygon:sourceBarcodePolygon(source),printProcess:'unknown',association:'same_frame_expected_barcode'}],requiredGroups:['print','carton','context']};
    const job={schemaVersion:'surface-job/1',jobId:'native_contract_jpeg',operation:'extract',profileId:'research-paper-v1',requestedScope:'assembly',enrollment:capture};
    await writeFile(join(directory,'job.json'),JSON.stringify(job));
    await exec(python,['-m','packproof_surface','--input',join(directory,'job.json'),'--output',join(directory,'result.json'),'--media-root',directory],{cwd:worker,timeout:30_000,env:{...process.env,OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'}});
    const result=JSON.parse(await readFile(join(directory,'result.json'),'utf8'));
    assert.equal(result.schemaVersion,'surface-result/1');assert.equal(result.qualification,'unqualified');
    assert(['unsupported','inconclusive','not_checked'].includes(result.status));
    assert.equal(result.sourceDigests[0].sha256,source.sha256);
    for(const scope of ['label','carton','assembly'])assert(['unsupported','inconclusive','not_checked'].includes(result.scopeResults[scope].status));
  }finally{await rm(directory,{recursive:true,force:true});}
});
