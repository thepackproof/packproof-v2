import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from '../hash.js';
import { canonicalize } from '../../../packages/evidence-contracts/contracts.mjs';
import type { Feature,RndDeps } from './types.js';

/** Freeze executable bytes in job identity; a deployment cannot silently change a queued method. */
export async function executableInventory(deps:RndDeps,feature:Feature) {
 const inventory:Record<string,string>={};
 for(const name of ['analyses','worker','security','matrix','capture']){
  const compiled=new URL(`./${name}.js`,import.meta.url),source=compiled.pathname.replace(/\.js$/,'.ts');
  inventory[`backend/${name}`]=sha256Hex(await readFile(source).catch(()=>readFile(compiled)));
 }
 inventory.contracts=sha256Hex(await readFile(new URL('../../../packages/evidence-contracts/contracts.mjs',import.meta.url)));
 for(const name of ['method','config','enrollment','learning-registry','platform-assurance']){
  const compiled=new URL(`./${name}.js`,import.meta.url);
  inventory[`backend/${name}`]=sha256Hex(await readFile(compiled.pathname.replace(/\.js$/,'.ts')).catch(()=>readFile(compiled)));
 }
 if(feature==='proofshield'&&deps.rnd?.zk){inventory.zkExecutable=sha256Hex(await readFile(deps.rnd.zk.script));inventory.zkVerificationRegistry=sha256Hex(await readFile(deps.rnd.zk.verificationRegistryFile));for(const name of ['circuit.mjs','verify.mjs','package-lock.json'])inventory[`zk/${name}`]=sha256Hex(await readFile(path.join(path.dirname(deps.rnd.zk.script),name)));}
 const script=feature==='proofwitness'?deps.rnd?.witness?.script:['proofprint','proofsight','prooftwin','prooflive','proofpilot','proofshield','proofmatch'].includes(feature)?deps.rnd?.worker?.script:undefined;
 if(script){
  const entry=feature==='proofshield'?path.resolve(path.dirname(script),'../privacy/redact.py'):script;
  inventory.worker=sha256Hex(await readFile(entry));
  if(feature!=='proofshield'&&feature!=='proofwitness')for(const name of ['engine.py','sfm.py','policy.json']){
   try{inventory[name]=sha256Hex(await readFile(path.join(path.dirname(script),name)));}catch{inventory[name]='ABSENT';}
  }
 }
 if(feature==='proofsight'&&deps.rnd?.worker?.proofsightModel){const model=deps.rnd.worker.proofsightModel;const hash=sha256Hex(await readFile(model.path));if(hash!==model.sha256)throw Object.assign(new Error('Pinned model changed'),{code:'RND_MODEL_INVALID'});inventory.proofsightModel=hash;inventory.proofsightModelRelease=sha256Hex(model.releaseId);}
 if(feature==='proofwitness'&&deps.rnd?.witness)inventory.witnessTrustPolicy=sha256Hex(await readFile(deps.rnd.witness.trustPolicyFile));
 return {digest:sha256Hex(canonicalize(inventory)),files:inventory};
}
