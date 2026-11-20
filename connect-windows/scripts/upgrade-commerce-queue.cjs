// Runs inside the pinned Electron runtime on a disposable installation test machine.
const {app}=require('electron');
const {join}=require('node:path');
const fs=require('node:fs/promises');
const {randomBytes,createHash}=require('node:crypto');
const [mode,bundle,root]=process.argv.slice(2);
if(process.platform!=='win32' || process.env.APP_ENV!=='development' || process.env.GITHUB_ACTIONS!=='true' || !['seed','replay'].includes(mode))
  throw Error('The Commerce queue fixture requires a disposable development Windows runner.');
const profile=join(process.env.LOCALAPPDATA,'PackProof Dev');
app.setName('PackProof Dev');
app.setPath('userData',profile);
const {SecureStore,EvidenceEngine,EvidenceStore}=require(bundle);
async function run() {
  // The installed app must already have made its own DPAPI identity. This fixture
  // may open it but must never synthesize one in its place.
  await fs.access(join(profile,'Credentials','installation.vault'));
  const installation=await new SecureStore(join(profile,'Credentials')).installation();
  const account='upgrade-test-account';
  const directory=join(profile,'EvidenceQueue');
  const engine=new EvidenceEngine({rootDir:directory,encryptionKey:installation.key,automaticProcessing:false,
    api:{authorizeCapture:async()=>({id:'isolated-session',maxRecordingBytes:4096,maxRecordingSeconds:10})}});
  await engine.initialize();
  await engine.setAccount(account);
  const fixture=join(root,'commerce-queue.json');
  if(mode==='seed') {
    if(engine.list().length) throw Error('The historical Commerce queue must start empty.');
    const bytes=randomBytes(256);
    const job=await engine.beginCapture({proofId:'proof_upgrade',label:'Upgrade fixture',camera:'Synthetic capture',mimeType:'video/webm',
      appVersion:'upgrade-qualified',installationId:installation.id});
    await engine.appendChunk(job.id,0,bytes);
    await engine.stageCapture(job.id,{attestation:false,recordedDurationMs:1000});
    await fs.writeFile(fixture,JSON.stringify({id:job.id,installationId:installation.id,hash:createHash('sha256').update(bytes).digest('hex')}));
  } else {
    const expected=JSON.parse(await fs.readFile(fixture,'utf8'));
    const job=engine.list().find(item=>item.id===expected.id);
    const original=await new EvidenceStore(directory,installation.key).readChunk(account,expected.id,0);
    if(installation.id!==expected.installationId || !job || !engine.hasPending || engine.unreadableJobCount!==0 ||
      createHash('sha256').update(original).digest('hex')!==expected.hash) throw Error('Commerce identity, staged job or original bytes changed.');
  }
}
app.whenReady().then(run).then(()=>app.exit(0)).catch(()=>{console.error('The protected Commerce upgrade queue failed its '+mode+' check.');app.exit(1);});
