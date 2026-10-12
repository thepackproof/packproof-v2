import {it,expect} from 'vitest';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {executableInventory} from '../src/rnd/method.js';
import {sha256Hex} from '../src/hash.js';
import type {RndDeps} from '../src/rnd/types.js';

it('hashes real TypeScript method bytes in source mode on Windows and POSIX',async()=>{
 const inventory=await executableInventory({} as RndDeps,'verifiedcapture');
 expect(inventory.files['backend/method']).toBe(sha256Hex(await readFile(new URL('../src/rnd/method.ts',import.meta.url))));
 expect(inventory.files.contracts).toBe(sha256Hex(await readFile(new URL('../../packages/evidence-contracts/contracts.mjs',import.meta.url))));
 expect((await executableInventory({} as RndDeps,'verifiedcapture')).digest).toBe(inventory.digest);
});
it('changes queued method identity when any imported vision helper changes',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'packproof-rnd-method-'));
 try{
  const script=path.join(directory,'worker.py');await writeFile(script,'# synthetic worker');
  const helpers=['engine.py','sfm.py','enrollment.py','action_model.py','segmentation.py','ocr_runtime.py','policy.json'];
  for(const name of helpers)await writeFile(path.join(directory,name),`fixture:${name}`);
  const deps={rnd:{worker:{script}}} as RndDeps;
  let previous=await executableInventory(deps,'proofpilot');
  for(const name of helpers){await writeFile(path.join(directory,name),`changed:${name}`);const next=await executableInventory(deps,'proofpilot');expect(next.digest).not.toBe(previous.digest);expect(next.files[name]).toBe(sha256Hex(`changed:${name}`));previous=next;}
 }finally{await rm(directory,{recursive:true,force:true});}
});
