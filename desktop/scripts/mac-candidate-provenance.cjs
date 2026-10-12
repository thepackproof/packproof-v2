'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {Readable, Transform} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const {execFileSync} = require('node:child_process');
const appInputs = ['desktop/src', 'desktop/build', 'desktop/index.html', 'desktop/vite.config.ts', 'desktop/tsconfig.json', 'desktop/package.json', 'desktop/package-lock.json', 'desktop/electron-builder.config.cjs', 'desktop/scripts/build.mjs', 'desktop/scripts/release-policy.cjs', 'desktop/scripts/notarize-dmg.cjs', 'web', 'mobile/src', 'packages'];
function insist(value, message) { if (!value) throw new Error(message); }
function validateCandidate(candidate, arch) {
  insist(candidate?.repository === 'thepackproof/packproof-v2', 'Unexpected candidate repository.');
  insist(/^[a-f0-9]{40}$/.test(candidate.sourceCommit) && Number.isSafeInteger(candidate.runId) && candidate.runId > 0 && /^[A-Z0-9]{10}$/.test(candidate.teamId), 'Invalid candidate identity.');
  insist(['x64','arm64'].includes(arch) && Array.isArray(candidate.artifacts) && candidate.artifacts.length === 2, 'Both native Mac artifacts are required.');
  for (const expected of ['x64','arm64']) {
    const matches = candidate.artifacts.filter(item => item.arch === expected);
    insist(matches.length === 1 && Number.isSafeInteger(matches[0].id) && matches[0].id > 0 && /^sha256:[a-f0-9]{64}$/.test(matches[0].digest), 'Invalid or duplicate candidate artifact.');
  }
  insist(new Set(candidate.artifacts.map(item=>item.id)).size === 2, 'Duplicate candidate artifact ID.');
  return candidate.artifacts.find(item=>item.arch===arch);
}
function validateProvenance(candidate, arch, run, jobs, artifact) {
  const expected = validateCandidate(candidate, arch);
  insist(run.id === candidate.runId && run.repository?.full_name === candidate.repository && run.head_repository?.full_name === candidate.repository && run.head_sha === candidate.sourceCommit && run.head_branch === 'main' && run.event === 'workflow_dispatch' && run.path === '.github/workflows/desktop-release.yml' && run.status === 'completed', 'Candidate run provenance mismatch.');
  // The historical run failed on Windows. Each selected Mac signing job must have succeeded.
  for (const item of candidate.artifacts) {
    const matches = jobs.filter(job=>job.name===`Signed production / darwin / ${item.arch}`);
    insist(matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === 'success', 'Candidate Mac signing job did not pass.');
  }
  insist(artifact.id === expected.id && artifact.name === `packproof-desktop-production-darwin-${arch}-${candidate.sourceCommit}` && artifact.digest === expected.digest && artifact.expired === false && artifact.workflow_run?.id === candidate.runId && artifact.workflow_run?.head_sha === candidate.sourceCommit, 'Candidate artifact provenance mismatch.');
  return expected;
}
async function downloadArchive(candidate, expected, directory) {
  insist(path.isAbsolute(directory) && !fs.existsSync(directory), 'Fresh absolute artifact destination required.');
  insist(process.env.GH_TOKEN, 'GitHub token required for archive download.');
  const temporary=fs.mkdtempSync(path.join(path.dirname(directory),'mac-archive-'));
  const archive=path.join(temporary,'candidate.zip');
  try {
    const response=await fetch(`https://api.github.com/repos/${candidate.repository}/actions/artifacts/${expected.id}/zip`,{headers:{Authorization:`Bearer ${process.env.GH_TOKEN}`,Accept:'application/vnd.github+json'},redirect:'manual',signal:AbortSignal.timeout(30000)});
    insist(response.status===302,'GitHub did not provide the exact artifact archive.');
    const url=new URL(response.headers.get('location'));
    insist(url.protocol==='https:' && !url.username && !url.password,'Invalid archive download destination.');
    // Credentials stay on api.github.com; the signed blob request carries no token.
    const archiveResponse=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(600000)});
    insist(archiveResponse.ok && archiveResponse.body,'Artifact archive download failed.');
    const digest=crypto.createHash('sha256');let bytes=0;
    await pipeline(Readable.fromWeb(archiveResponse.body),new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;if(bytes>2*1024*1024*1024)return callback(new Error('Artifact archive exceeds limit.'));digest.update(chunk);callback(null,chunk);}}),fs.createWriteStream(archive,{flags:'wx',mode:0o600}));
    insist(`sha256:${digest.digest('hex')}`===expected.digest,'Downloaded archive digest does not match the pinned signed candidate.');
    const entries=execFileSync('unzip',['-Z1',archive],{encoding:'utf8',maxBuffer:1024*1024}).trim().split('\n');
    insist(entries.length>0 && entries.length<500 && entries.every(name=>name && !name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..')),'Unsafe archive entries.');
    fs.mkdirSync(directory);
    execFileSync('unzip',['-q',archive,'-d',directory],{stdio:'pipe'});
    return {downloadedArchiveDigest:expected.digest,downloadedArchiveBytes:bytes,archiveDigestVerified:true};
  } finally { fs.rmSync(temporary,{recursive:true,force:true}); }
}
async function main() {
  const [descriptor, arch, output, directory] = process.argv.slice(2);
  insist(descriptor && output && [5,6].includes(process.argv.length), 'Usage: mac-candidate-provenance.cjs descriptor arch output [fresh-download-directory]');
  const candidate = JSON.parse(fs.readFileSync(descriptor,'utf8'));
  const expected = validateCandidate(candidate, arch);
  const gh = endpoint => JSON.parse(execFileSync('gh',['api',`repos/${candidate.repository}/${endpoint}`], {encoding:'utf8',maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']}));
  const run = gh(`actions/runs/${candidate.runId}`);
  const jobs = gh(`actions/runs/${candidate.runId}/jobs?filter=latest&per_page=100`);
  insist(jobs.total_count <= 100, 'Unexpected job pagination; refusing incomplete provenance.');
  validateProvenance(candidate,arch,run,jobs.jobs,gh(`actions/artifacts/${expected.id}`));
  execFileSync('git',['diff','--exit-code','--quiet',candidate.sourceCommit,'HEAD','--',...appInputs],{stdio:'pipe'});
  const harnessSourceCommit = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const receipt = {schema:'packproof.mac-candidate-provenance.v1',checkedAt:new Date().toISOString(),candidateSourceCommit:candidate.sourceCommit,harnessSourceCommit,repository:candidate.repository,runId:candidate.runId,arch,artifactId:expected.id,artifactDigest:expected.digest,appInputsUnchanged:appInputs,scope:'Existing signed candidate with unchanged application build inputs; no release approval.'};
  if(directory) Object.assign(receipt,await downloadArchive(candidate,expected,directory));
  fs.writeFileSync(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  if(process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,`artifact-id=${expected.id}\nrun-id=${candidate.runId}\nsource-commit=${candidate.sourceCommit}\nteam-id=${candidate.teamId}\n`);
  console.log('Exact signed candidate provenance and unchanged application inputs verified.');
}
module.exports = {validateCandidate,validateProvenance,appInputs};
if (require.main === module) main().catch(error => { console.error('Mac candidate provenance refused: '+(error.status !== undefined ? 'external verification failed' : error.message)); process.exitCode=1; });
