/** Runs only a caller-supplied local research image, without network access. */
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';

const image=process.argv[2],report=process.argv[3]==='--report'?process.argv[4]:null;
if(!image||![3,5].includes(process.argv.length)||(process.argv.length===5&&!report)||!/^packproof-rnd-smoke(?::[a-zA-Z0-9_.-]+)?$/.test(image))throw Error('Pass the explicitly built local packproof-rnd-smoke image and optional --report path.');
const name='packproof-rnd-smoke-'+randomUUID();
let step='start',lastProbeError='',started=false;
const receipt={state:'FAIL',sourceSha:process.env.GITHUB_SHA??null,image,network:'none',productionQualified:false};
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:90000,maxBuffer:1048576,stdio:['ignore','pipe','pipe']}).trim();
const probe=`const base='http://127.0.0.1:3000';
const check=async()=>{
 if((await fetch(base+'/health')).status!==200)throw Error('health');
 if((await fetch(base+'/rnd/capabilities')).status!==401)throw Error('auth');
 const login=await fetch(base+'/auth/dev/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({subject:'container-smoke@example.test'})});
 if(!login.ok)throw Error('login');const {token}=await login.json();const headers={Authorization:'Bearer '+token};
 const cap=await (await fetch(base+'/rnd/capabilities',{headers})).json();
 if(cap.enabled!==false||cap.killSwitch!==true||cap.releaseAuthorized!==false||Object.values(cap.features).some(f=>Object.values(f).some(Boolean)))throw Error('flags');
 const me=await (await fetch(base+'/me',{headers})).json();if(!me.userId)throw Error('identity');
 console.log(JSON.stringify({userId:me.userId,health:200,unauthorized:401,optionalProcessing:false}));
};await check();`;
async function ready(){
 const deadline=Date.now()+90000;
 while(Date.now()<deadline){try{return JSON.parse(docker('exec',name,'node','--input-type=module','-e',probe));}catch(error){lastProbeError=String(error.stderr??'').match(/(?:ECONNREFUSED|Error: (?:health|auth|login|flags|identity)|Cannot find (?:package|module))/)?.[0]??'Probe unavailable';await new Promise(resolve=>setTimeout(resolve,1000));}}
 throw Error(`Isolated container did not become ready within 90 seconds (${lastProbeError}).`);
}
try{
 docker('run','--detach','--network','none','--name',name,image);
 started=true;step='non-root identity';
 assert.equal(docker('exec',name,'id','-u'),'1000');
 step='initial API readiness';const first=await ready();step='restart';docker('restart',name);step='restarted API readiness';const restarted=await ready();
 assert.equal(first.userId,restarted.userId,'Restart must retain the local database and identity.');
 Object.assign(receipt,{state:'PASS',uid:1000,restartPreservedIdentity:true,health:200,researchUnauthenticated:401,optionalProcessing:false});
}catch(error){
 Object.assign(receipt,{failedStep:step,error:step.includes('readiness')?String(error.message):`Container gate failed at ${step}`,lastProbeError});
 // Extract only named static error categories; never include runtime config or key bytes.
 if(started){try{const logs=docker('logs','--tail','100',name);receipt.diagnostics=[...new Set(logs.match(/(?:ERR_MODULE_NOT_FOUND|EACCES|ENOENT|Research runtime isolation|Database schema|Migration failed|Signing configuration)/g)??[])];}catch{receipt.diagnostics=['Container logs unavailable'];}}
 process.exitCode=1;
}finally{
 if(started){try{docker('rm','--force',name);receipt.cleanup='REMOVED';}catch{receipt.cleanup='FAILED';receipt.state='FAIL';process.exitCode=1;}}
 receipt.completedAt=new Date().toISOString();
 if(report)writeFileSync(report,JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify(receipt));
}
