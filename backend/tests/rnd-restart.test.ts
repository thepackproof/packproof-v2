import { it,expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

it('reopens a durable database in a new OS process and recovers an expired unfinished lease exactly once',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'packproof-rnd-restart-'));
 try{
  const child=new URL('./rnd-restart-child.ts',import.meta.url).pathname,cwd=new URL('../',import.meta.url).pathname;
  const seed=await promisify(execFile)(process.execPath,['--import','tsx',child,'seed',directory],{cwd,timeout:60000,maxBuffer:1024*1024});
  expect(JSON.parse(await readFile(path.join(directory,'state.json'),'utf8')).analysisId).toMatch(/^rnd_analysis_/);
  const next=await promisify(execFile)(process.execPath,['--import','tsx',child,'recover',directory],{cwd,timeout:60000,maxBuffer:1024*1024});
  expect(JSON.parse(await readFile(path.join(directory,'recovered.json'),'utf8'))).toMatchObject({state:'SUCCEEDED',attempts:2,extensions:1,result:{state:'SUCCEEDED'}});
 }finally{await rm(directory,{recursive:true,force:true});}
},120000);
