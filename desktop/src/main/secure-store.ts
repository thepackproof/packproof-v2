import {safeStorage} from 'electron';
import {mkdir,open,readFile,rename,unlink,readdir} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
export async function atomicWrite(path:string,bytes:Buffer):Promise<void>{
 const temp=`${path}.${randomUUID()}.tmp`;const f=await open(temp,'wx',0o600);
 try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}
 try{await rename(temp,path);try{const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}}catch(error){if(!['EINVAL','EPERM','EISDIR','EBADF'].includes((error as NodeJS.ErrnoException).code??''))throw error;}}catch(e){await unlink(temp).catch(()=>{});throw e;}
}
export function secureStorageAvailable(){return safeStorage.isEncryptionAvailable() && (process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text');}
export class SecureStore{
 constructor(private readonly dir:string){}
 private path(name:string){if(!/^[a-z0-9-]{1,40}$/.test(name))throw new Error('Invalid storage name');return join(this.dir,`${name}.vault`);}
 async read(name:string):Promise<string|null>{if(!secureStorageAvailable())throw new Error('OS credential storage is unavailable. Unlock your system keychain.');try{return safeStorage.decryptString(await readFile(this.path(name)));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
 async write(name:string,value:string){if(!secureStorageAvailable())throw new Error('OS credential storage is unavailable. Unlock your system keychain.');await mkdir(this.dir,{recursive:true,mode:0o700});await atomicWrite(this.path(name),safeStorage.encryptString(value));}
 async clear(name:string){await unlink(this.path(name)).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 async installation(){let stored=await this.read('installation');if(!stored){const queueEntries=await readdir(join(this.dir,'..','EvidenceQueue')).catch(error=>{if(error.code==='ENOENT')return [];throw error;});if(queueEntries.length)throw new Error('The encryption credential is missing for existing local evidence. Preserve this computer’s PackProof data and contact support.');stored=JSON.stringify({id:randomUUID(),key:randomBytes(32).toString('base64')});await this.write('installation',stored);}const parsed=JSON.parse(stored);if(typeof parsed.id!=='string'||Buffer.from(parsed.key,'base64').length!==32)throw new Error('Installation credential is damaged; retain the evidence queue and contact support.');return {id:parsed.id as string,key:Buffer.from(parsed.key,'base64')};}
}
