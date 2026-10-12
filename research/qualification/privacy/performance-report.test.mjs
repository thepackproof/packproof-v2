import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {checkReport,checkArtifacts} from './performance-report.mjs';

function fixture(){
  return {schemaVersion:'packproof.zk-performance-preflight.v1',passed:true,qualificationPassed:false,independentReview:false,publicReliance:false,
    profile:4,requestedSamples:1,compileMs:20,maxRssKiB:512,
    source:{head:'a'.repeat(40),workingTreeDirty:true,files:Array.from({length:4},()=>({sha256:'b'.repeat(64)}))},
    measurements:[{sample:1,verified:true,proveMs:17,verifyMs:2,proofJsonBytes:5,bundleBytes:8,proofSha256:'c'.repeat(64),outputSha256:'d'.repeat(64)}],
    descriptiveSummary:{proveMs:{count:1,min:17,median:17,max:17},verifyMs:{count:1,min:2,median:2,max:2}}};
}
test('valid receipt retains explicit qualification and verification limits',()=>{
  const result=checkReport(fixture());assert.equal(result.receiptValid,true);assert.equal(result.qualificationPassed,false);assert.equal(result.proofVerificationRepeated,false);
});
test('failed, incomplete, unsupported or overclaimed measurements are rejected',()=>{
  for(const mutate of [r=>r.passed=false,r=>r.qualificationPassed=true,r=>r.independentReview=true,r=>r.publicReliance=true,
    r=>r.profile=16,r=>r.requestedSamples=0,r=>r.requestedSamples=4,r=>r.measurements=[],r=>r.measurements[0].verified=false,
    r=>r.measurements[0].proveMs=NaN,r=>r.measurements[0].verifyMs=-1,r=>r.measurements[0].sample=2,
    r=>r.descriptiveSummary.proveMs.median=1,r=>r.source.files[0].sha256='not-pinned']){
    const receipt=fixture();mutate(receipt);assert.throws(()=>checkReport(receipt));
  }
});
test('stored public artifacts must match exact receipt hashes',()=>{
  const directory=mkdtempSync(join(tmpdir(),'packproof-measurement-'));
  try{
    mkdirSync(join(directory,'sample-1'));
    const receipt=fixture();
    const bundle={proof:{synthetic:'proof'},other:'public synthetic context'};
    receipt.measurements[0].proofJsonBytes=Buffer.byteLength(JSON.stringify(bundle.proof));
    receipt.measurements[0].bundleBytes=Buffer.byteLength(JSON.stringify(bundle));
    for(const [file,field] of [['proof.json','proofSha256'],['output.png','outputSha256']]){
      const bytes=Buffer.from(file==='proof.json'?JSON.stringify(bundle,null,2):`synthetic ${file}`);writeFileSync(join(directory,'sample-1',file),bytes);
      receipt.measurements[0][field]=createHash('sha256').update(bytes).digest('hex');
    }
    const path=join(directory,'performance.json');
    assert.equal(checkArtifacts(receipt,path).artifactHashesMatched,true);
    receipt.measurements[0].proofJsonBytes++;
    assert.throws(()=>checkArtifacts(receipt,path));
    receipt.measurements[0].proofJsonBytes--;
    writeFileSync(join(directory,'sample-1','output.png'),'substitution');
    assert.throws(()=>checkArtifacts(receipt,path));
  }finally{rmSync(directory,{recursive:true,force:true});}
});
