'use strict';
// Download an exact CI-produced candidate without creating another cloud transfer URL.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const temp=process.env.RUNNER_TEMP,env=process.env;
const insist=(ok,message)=>{if(!ok)throw Error(message);};
const gh=args=>cp.execFileSync('gh',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
(async()=>{
 insist(env.GITHUB_ACTIONS&&temp,'Disposable CI runner required');
 let expected='229f9238289a40da2f780dd6fe4bd2091ee45fff2946de4ed40e86cea6a3dfa4';
 if(env.CUSTOMER_ANDROID_PACKAGE==='candidate-bundle-test-signature'){
  insist(/^\d+$/.test(env.CANDIDATE_BUILD_RUN||'')&&/^[a-f0-9]{40}$/.test(env.CANDIDATE_SOURCE_SHA||'')&&/^[a-f0-9]{64}$/.test(env.CANDIDATE_AAB_SHA256||''),'Exact candidate provenance required');
  const run=JSON.parse(gh(['api',`repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.CANDIDATE_BUILD_RUN}`]));
  insist(run.conclusion==='success'&&run.head_branch==='main'&&run.head_sha===env.CANDIDATE_SOURCE_SHA&&run.path==='.github/workflows/android-aab.yml','Candidate workflow provenance mismatch');
  const jobs=JSON.parse(gh(['api',`repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.CANDIDATE_BUILD_RUN}/jobs`]));
  insist(jobs.jobs.some(j=>j.name==='Signed Android release AAB'&&j.conclusion==='success'),'Signed candidate build did not run');
  const directory=path.join(temp,'candidate-65');
  gh(['run','download',env.CANDIDATE_BUILD_RUN,'--repo',env.GITHUB_REPOSITORY,'--name','packproof-1.0.1-65-aab','--dir',directory]);
  const verification=JSON.parse(fs.readFileSync(path.join(directory,'android-release-verification.json'),'utf8'));
  insist(verification.passed&&verification.expo_record_field_annotation?.preserved===true,'Candidate native annotation guard failed');
  fs.copyFileSync(path.join(directory,'packproof-1.0.1-65.aab'),path.join(temp,'64.aab'));
  expected=env.CANDIDATE_AAB_SHA256;
 }else{
  const response=await fetch(env.AAB_URL);insist(response.ok,'Published AAB download failed');
  fs.writeFileSync(path.join(temp,'64.aab'),Buffer.from(await response.arrayBuffer()));
 }
 insist(crypto.createHash('sha256').update(fs.readFileSync(path.join(temp,'64.aab'))).digest('hex')===expected,'Bundle digest mismatch');
 console.log('Exact Android bundle identity and digest verified');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
