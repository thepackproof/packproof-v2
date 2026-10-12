/** Offline measurement-receipt integrity; does not verify proofs or qualify crypto. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export function checkReport(report){
  assert.equal(report.schemaVersion,'packproof.zk-performance-preflight.v1');
  assert.equal(report.passed,true);
  for(const flag of ['qualificationPassed','independentReview','publicReliance'])assert.equal(report[flag],false);
  assert.ok([4,8].includes(report.profile));
  assert.ok(Number.isInteger(report.requestedSamples)&&report.requestedSamples>=1&&report.requestedSamples<=3);
  assert.equal(report.measurements.length,report.requestedSamples);
  assert.ok(Number.isFinite(report.compileMs)&&report.compileMs>=0);
  assert.ok(Number.isFinite(report.maxRssKiB)&&report.maxRssKiB>=0);
  assert.match(report.source.head,/^[a-f0-9]{40}$/);
  assert.equal(typeof report.source.workingTreeDirty,'boolean');
  assert.ok(report.source.files.length>=4);
  for(const file of report.source.files)assert.match(file.sha256,/^[a-f0-9]{64}$/);
  for(const [index,row] of report.measurements.entries()){
    assert.equal(row.sample,index+1);assert.equal(row.verified,true);
    for(const metric of ['proveMs','verifyMs'])assert.ok(Number.isFinite(row[metric])&&row[metric]>=0);
    for(const size of ['proofJsonBytes','bundleBytes'])assert.ok(Number.isSafeInteger(row[size])&&row[size]>0);
    for(const hash of ['proofSha256','outputSha256'])assert.match(row[hash],/^[a-f0-9]{64}$/);
  }
  for(const metric of ['proveMs','verifyMs']){
    const values=report.measurements.map(row=>row[metric]).sort((a,b)=>a-b);
    const n=values.length;
    assert.deepEqual(report.descriptiveSummary[metric],{count:n,min:values[0],median:n%2?values[(n-1)/2]:(values[n/2-1]+values[n/2])/2,max:values.at(-1)});
  }
  return {receiptValid:true,measurementCount:report.measurements.length,qualificationPassed:false,
    proofVerificationRepeated:false,scope:'Measurement structure and stored artifact integrity only; no independent cryptographic or performance qualification.'};
}

export function checkArtifacts(report,path){
  const result=checkReport(report);
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  const storedArtifacts=[];
  for(const row of report.measurements){
    const directory=join(dirname(path),`sample-${row.sample}`);
    const proofBytes=readFileSync(join(directory,'proof.json')),outputBytes=readFileSync(join(directory,'output.png'));
    assert.equal(digest(proofBytes),row.proofSha256);
    assert.equal(digest(outputBytes),row.outputSha256);
    const bundle=JSON.parse(proofBytes);
    assert.equal(Buffer.byteLength(JSON.stringify(bundle.proof)),row.proofJsonBytes);
    assert.equal(Buffer.byteLength(JSON.stringify(bundle)),row.bundleBytes);
    storedArtifacts.push({sample:row.sample,formattedBundleFileBytes:proofBytes.length,outputFileBytes:outputBytes.length});
  }
  return {...result,artifactHashesMatched:true,compactSerializationCountsMatched:true,storedArtifacts};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    assert.equal(process.argv.length,3);
    const path=resolve(process.argv[2]),raw=readFileSync(path);
    assert.ok(raw.length<=1024*1024);
    console.log(JSON.stringify(checkArtifacts(JSON.parse(raw),path),null,2));
  }catch{
    console.log(JSON.stringify({receiptValid:false,failureCode:'MEASUREMENT_RECEIPT_REJECTED',qualificationPassed:false}));
    process.exitCode=1;
  }
}
