import { open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPgDatabase } from "./postgres.js";
import { loadConfig } from "../config.js";
import { createObjectStore } from "../s3/create-object-store.js";
import { restoreFreshRecoveryDatabase } from "../domain/recovery-restore.js";

/** Offline operator entrypoint. No runtime DATABASE_URL fallback and no migration/guard bypass. */
async function main() {
  const [specFile,reportFile]=process.argv.slice(2);
  const databaseUrl=process.env.PACKPROOF_RESTORE_DATABASE_URL;
  const trustFile=process.env.PACKPROOF_RESTORE_TRUST_FILE;
  if(!specFile||!reportFile||!databaseUrl||!trustFile)throw new Error('Restore requires a spec path, a new report path, PACKPROOF_RESTORE_DATABASE_URL and independently provisioned PACKPROOF_RESTORE_TRUST_FILE');
  const spec=JSON.parse(await readFile(specFile,'utf8')) as {
    version:number; expectedDatabase:string; restoreRole:string; isolatedTargetReference:string;oldWriterFenceReference:string;targetWriterGeneration:string;
    core:{envelopes:string[];expectedWatermark:string};policy:{envelopes:string[];expectedWatermark:string};
  };
  if(spec.version!==1)throw new Error('Unsupported restore spec version');
  const trust=JSON.parse(await readFile(trustFile,'utf8')) as {publicKeys:Record<string,string>};
  if(!trust.publicKeys||Object.values(trust.publicKeys).some(value=>typeof value!=='string'||!value.includes('BEGIN PUBLIC KEY')||value.includes('PRIVATE KEY')))throw new Error('Restore trust input must contain independently pinned public keys only');
  const directory=path.dirname(path.resolve(specFile));let total=0;
  const bytes=async(name:string)=>{
    const file=await open(path.resolve(directory,name),'r');
    try {
      const limit=Math.min(16*1024*1024,256*1024*1024-total),metadata=await file.stat();
      if(!metadata.isFile()||metadata.size>limit)throw new Error('Restore bundle exceeds the bounded CLI admission limit');
      const chunks:Buffer[]=[];let received=0;
      for await(const chunk of file.createReadStream({highWaterMark:65536,autoClose:false})){
        received+=chunk.length;
        if(received>limit)throw new Error('Restore bundle exceeds the bounded CLI admission limit');
        chunks.push(chunk as Buffer);
      }
      total+=received;return Buffer.concat(chunks,received);
    }finally{await file.close();}
  };
  const bundle=async(input:{envelopes:string[];expectedWatermark:string})=>{
    if(!Array.isArray(input.envelopes)||!input.envelopes.length||input.envelopes.length>10000)throw new Error('Restore needs a bounded complete journal inventory');
    const envelopes=[];for(const name of input.envelopes)envelopes.push(await bytes(name));
    return {envelopes,expectedWatermark:await bytes(input.expectedWatermark)};
  };
  const core=await bundle(spec.core),policy=await bundle(spec.policy);
  const sourceStore=createObjectStore(loadConfig(process.env));
  if(!sourceStore.immutableRecoveryJournal)throw new Error('CLI restoration requires an independently verified protected source store');
  const opened=createPgDatabase(databaseUrl,undefined,process.env);
  try {
    const report=await restoreFreshRecoveryDatabase(opened.db,{...spec,core,policy,sourceStore,trustedPublicKey:async id=>trust.publicKeys[id]??null});
    await writeFile(reportFile,`${JSON.stringify(report,null,2)}\n`,{flag:'wx',mode:0o600});
    process.stdout.write(JSON.stringify({event:'fresh_recovery_reconstruction_complete',trafficMayOpen:false,writersEnabled:false})+'\n');
  } finally {await opened.close();}
}

main().catch(error=>{
  // Never dump a connection string, signed snapshot, token hash, or provider error.
  const code=error&&typeof error==='object'&&'code' in error?String(error.code):'RECOVERY_RESTORE_FAILED';
  process.stderr.write(JSON.stringify({event:'fresh_recovery_reconstruction_failed',code,trafficMayOpen:false})+'\n');
  process.exitCode=1;
});
