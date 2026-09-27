import {appendFile,mkdir,rename,stat,readFile} from 'node:fs/promises';
import {join} from 'node:path';
export class Diagnostics{
 private writes=Promise.resolve();
 constructor(private readonly dir:string,private readonly version:string,private readonly reporter?:(category:string,code:string)=>void){}
 async recentEntries(){
  await this.writes;
  const bytes=await readFile(join(this.dir,'desktop.log'),'utf8').catch(()=>'');
  return bytes.split('\n').filter(Boolean).slice(-100).flatMap(line=>{try{const row=JSON.parse(line);if(!['AUTH','CAPTURE','UPLOAD','UPDATES','SYSTEM'].includes(row.category)||!/^([A-Z0-9_]){1,80}$/.test(row.code)||!Number.isFinite(Date.parse(row.at)))return [];return [{at:new Date(row.at).toISOString(),category:row.category,code:row.code}];}catch{return [];}});
 }
 record(category:'AUTH'|'CAPTURE'|'UPLOAD'|'UPDATES'|'SYSTEM',code:string){
  // A closed vocabulary of categories and bounded codes, never request bodies, URLs or error messages.
  this.reporter?.(category,code);
  const row={at:new Date().toISOString(),category,code:code.replace(/[^A-Z0-9_]/gi,'_').slice(0,80),version:this.version,platform:process.platform};
  this.writes=this.writes.catch(()=>{}).then(async()=>{await mkdir(this.dir,{recursive:true,mode:0o700});const path=join(this.dir,'desktop.log');if((await stat(path).catch(()=>null))?.size!>1024*1024)await rename(path,join(this.dir,'desktop.previous.log')).catch(()=>{});await appendFile(path,JSON.stringify(row)+'\n',{mode:0o600});}).catch(()=>{});
 }
}
