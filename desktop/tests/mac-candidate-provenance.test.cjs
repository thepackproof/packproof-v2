const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {validateCandidate,validateProvenance} = require('../scripts/mac-candidate-provenance.cjs');
const descriptor = require('../docs/mac-acceptance-candidate.json');
function fixture(arch='x64') {
  const candidate = structuredClone(descriptor), expected = candidate.artifacts.find(item=>item.arch===arch);
  return [candidate,arch,{id:candidate.runId,repository:{full_name:candidate.repository},head_repository:{full_name:candidate.repository},head_sha:candidate.sourceCommit,head_branch:'main',event:'workflow_dispatch',path:'.github/workflows/desktop-release.yml',status:'completed',conclusion:'failure'},candidate.artifacts.map(item=>({name:`Signed production / darwin / ${item.arch}`,status:'completed',conclusion:'success'})),{...expected,name:`packproof-desktop-production-darwin-${arch}-${candidate.sourceCommit}`,expired:false,workflow_run:{id:candidate.runId,head_sha:candidate.sourceCommit}}];
}
test('both native candidates remain valid when only the unrelated Windows job failed',()=>{
  for(const arch of ['x64','arm64']) assert.equal(validateProvenance(...fixture(arch)).arch,arch);
});
test('rejects wrong source, branch, workflow, repository and unsuccessful selected signing jobs',()=>{
  const mutations = [
    value=>value[2].head_sha='a'.repeat(40), value=>value[2].head_branch='research',
    value=>value[2].path='.github/workflows/desktop-ci.yml', value=>value[2].event='pull_request',
    value=>value[2].head_repository.full_name='someone/packproof-v2',
    value=>value[2].status='in_progress', value=>value[3][1].conclusion='failure',
    value=>value[3].push({...value[3][0]}),
  ];
  for(const mutate of mutations){ const value=fixture();mutate(value);assert.throws(()=>validateProvenance(...value)); }
});
test('rejects substituted, expired and differently sourced artifact archives',()=>{
  const mutations = [value=>value[4].id++,value=>value[4].digest='sha256:'+'a'.repeat(64),value=>value[4].expired=true,value=>value[4].name+='-replacement',value=>value[4].workflow_run.head_sha='a'.repeat(40),value=>value[4].workflow_run.id++];
  for(const mutate of mutations){const value=fixture();mutate(value);assert.throws(()=>validateProvenance(...value));}
});
test('candidate descriptor requires exact two architectures and distinct positive artifact IDs',()=>{
  for(const mutate of [value=>value.artifacts.pop(),value=>value.artifacts[1].arch='x64',value=>value.artifacts[1].id=value.artifacts[0].id,value=>value.artifacts[0].digest='unverified',value=>value.repository='wrong/repo']) {const value=structuredClone(descriptor);mutate(value);assert.throws(()=>validateCandidate(value,'x64'));}
  assert.throws(()=>validateCandidate(descriptor,'win32'));
});
test('release workflow propagates exact platform scope before cloud credential access',()=>{
  const workflow=YAML.parse(fs.readFileSync(path.join(__dirname,'../../.github/workflows/desktop-release.yml'),'utf8'));
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.platforms.options,['all','mac','windows']);
  assert.deepEqual(workflow.jobs.signed.needs,['plan','rnd-release-policy']);
  assert.match(workflow.jobs.signed.if,/needs\.rnd-release-policy\.outputs\.allowed == 'true'/);
  assert.match(workflow.jobs.signed.strategy.matrix,/needs\.plan\.outputs\.matrix/);
  assert.deepEqual(workflow.jobs.publish.needs,['plan','signed','rnd-release-policy']);
  assert.match(workflow.jobs.publish.if,/needs\.rnd-release-policy\.outputs\.allowed == 'true'/);
  assert.equal(workflow.jobs.publish.env.PACKPROOF_RELEASE_PLATFORMS,'${{ inputs.platforms }}');
  const steps=workflow.jobs.publish.steps;
  const gate=steps.findIndex(step=>step.name?.startsWith('Validate acceptance'));
  assert.ok(gate<steps.findIndex(step=>step.uses?.startsWith('aws-actions/configure-aws-credentials')));
  assert.match(steps[gate].run,/validateAcceptance\([\s\S]*process\.env\.PACKPROOF_RELEASE_PLATFORMS/);
  assert.equal(steps.find(step=>step.uses?.startsWith('actions/download-artifact')).with.pattern,'${{ needs.plan.outputs.artifact-pattern }}');
  // Execute the matrix planner for every scope to check actual runner/artifact routing.
  const script=workflow.jobs.plan.steps.find(step=>step.id==='scope').run.replace(/^node <<'NODE'\n/,'').replace(/\nNODE\s*$/,'');
  const vm=require('node:vm');
  for(const [scope,wanted] of [['mac',['darwin/x64','darwin/arm64']],['windows',['win32/x64']],['all',['win32/x64','darwin/x64','darwin/arm64']]]) {
    let result='';
    vm.runInNewContext(script,{require:name=>name==='node:fs'?{appendFileSync:(_,value)=>result+=value}:require('../scripts/check-acceptance.cjs'),process:{env:{PACKPROOF_RELEASE_PLATFORMS:scope,RELEASE_CHANNEL:'production',GITHUB_SHA:descriptor.sourceCommit,GITHUB_OUTPUT:'unused'}}});
    const matrix=JSON.parse(result.split('\n')[0].slice('matrix='.length));
    assert.deepEqual(matrix.include.map(row=>`${row.platform}/${row.arch}`),wanted);
    assert.ok(result.includes(`artifact-pattern=packproof-desktop-production-${scope==='mac'?'darwin':scope==='windows'?'win32':'*'}-*-${descriptor.sourceCommit}`));
  }
});
