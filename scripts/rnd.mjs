#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,mkdirSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateRepository} from './rnd-release-guard.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [command,...args]=process.argv.slice(2);
const python=process.env.PACKPROOF_RND_PYTHON??'python3';
function run(program,argv,cwd=root){const p=spawnSync(program,argv,{cwd,stdio:'inherit',shell:false,env:process.env});if(p.error){process.stderr.write(`${p.error.message}\n`);process.exit(1);}if(p.status!==0)process.exit(p.status??1);}
function option(name,fallback){const i=args.indexOf(name);return i>=0?args[i+1]:fallback;}
if(command==='init'||command==='serve') {
 run(process.execPath,['scripts/rnd-runtime.mjs',command,...args]);
} else if(command==='doctor') {
 const probe=(program,argv)=>{const p=spawnSync(program,argv,{encoding:'utf8',timeout:10000});return {available:p.status===0,version:(p.stdout??p.stderr??'').split('\n')[0].slice(0,200)};};
 const result={schemaVersion:'packproof.rnd-doctor.v1',distribution:evaluateRepository(root),node:probe(process.execPath,['--version']),python:probe(python,['--version']),ffmpeg:probe('ffmpeg',['-version']),tesseract:probe('tesseract',['--version']),docker:probe('docker',['--version']),native:{androidSdk:!!(process.env.ANDROID_HOME&&existsSync(process.env.ANDROID_HOME)),xcode:probe('xcodebuild',['-version']).available},dependencies:{backend:existsSync(resolve(root,'backend/node_modules')),web:existsSync(resolve(root,'web/node_modules')),mobile:existsSync(resolve(root,'mobile/node_modules')),desktop:existsSync(resolve(root,'desktop/node_modules')),zk:existsSync(resolve(root,'research/privacy/zk/node_modules/o1js'))},qualifications:{physicalDevices:0,independentOperators:0,consentedPartners:0,releaseAuthorization:false},notes:['Tool availability is not physical qualification.','Set PACKPROOF_RND_PYTHON to the isolated vision/privacy environment; federation uses its own environment.','No credential values are included in this diagnostic.']};
 console.log(JSON.stringify(result,null,2));
 if(result.distribution.allowed)process.exitCode=1;
} else if(command==='test'&&args[0]==='core') {
 run(process.execPath,['scripts/rnd-release-guard.test.mjs']);
 run(process.execPath,['packages/evidence-contracts/test/contracts.test.mjs']);
 run('npm',['test','--','tests/canonical.test.ts','tests/core-integrity-audit.test.ts','tests/api-flow.test.ts','tests/durable-recovery.test.ts','tests/finalize-requirements.test.ts','tests/accounts-search-invitations.test.ts'],resolve(root,'backend'));
} else if(command==='test'&&args[0]==='research') {
 run(process.execPath,['packages/evidence-contracts/test/contracts.test.mjs']);
 run(process.execPath,['verifier/test_rnd_bundle.mjs']);
 const modules=readdirSync(resolve(root,'backend/tests')).filter(file=>/^rnd-.*\.test\.ts$/.test(file)).map(file=>'tests/'+file);
 if(!modules.length)throw new Error('Research backend tests are missing.');
 run('npm',['test','--',...modules],resolve(root,'backend'));
 run(python,['-m','unittest','discover','-s','research/benchmarks','-p','test_*.py']);
} else if(command==='bench') {
 const feature=args[0];const output=option('--output');if(!output)throw new Error('Use --output with a fresh private directory.');
 if(['F01','F03','F04','F06','F08','all'].includes(feature))run(python,['research/benchmarks/run.py','--feature',feature,'--output',resolve(output),...(args.includes('--sparse3d')?['--sparse3d']:[])]);
 else if(feature==='F07')run(process.execPath,['benchmark.mjs','--output',resolve(output)],resolve(root,'research/privacy/zk'));
 else if(feature==='F09')run(python,['-m','research.witness.benchmark','--output',resolve(output)]);
 else if(feature==='F10')run(process.env.PACKPROOF_RND_FEDERATED_PYTHON??python,['-m','proofcollective.cli','simulate','--output',resolve(output)],resolve(root,'research/federated'));
 else throw new Error('Use F01,F03,F04,F06,F07,F08,F09,F10 or all. F02/F05 use protocol/integration tests.');
} else if(command==='verify') {
 run(process.execPath,['verifier/rnd_bundle.mjs',...args]);
} else if(command==='report') {
 const ledger=JSON.parse(readFileSync(resolve(root,'docs/rnd/status-ledger.json'),'utf8'));
 const output={schemaVersion:'packproof.rnd-handoff.v1',generatedAt:new Date().toISOString(),distribution:evaluateRepository(root),ledger,measuredReports:['research/benchmarks/reports','research/privacy/reports','research/privacy/zk/reports','research/witness/reports','research/federated/reports'].filter(p=>existsSync(resolve(root,p))),releaseAuthorized:false};
 const file=option('--output');if(file){mkdirSync(dirname(resolve(file)),{recursive:true});writeFileSync(resolve(file),JSON.stringify(output,null,2)+'\n');console.log(resolve(file));}else console.log(JSON.stringify(output,null,2));
} else {
 console.log('Usage: npm run rnd -- init --dir /private/packproof-rnd | serve --dir /private/packproof-rnd | doctor | test core | test research | bench F01 --output /private/path | verify bundle.json --trust policy.json | report [--output path]\nBench F04 --sparse3d includes actual synthetic sparse reconstruction. F07/F09/F10 are separate isolated research commands. No command deploys, submits, uploads, or enables customer findings.');
 if(command)process.exitCode=2;
}
