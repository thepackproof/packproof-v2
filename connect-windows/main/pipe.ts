import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
export class ServiceBridge{
 constructor(private readonly resourcePath:string){}
 async request(operation:string,payload?:unknown):Promise<unknown>{
  if(process.platform!=='win32')throw Error('The background service requires Windows 11 x64.');
  const id=randomUUID(),request=JSON.stringify({version:1,id,operation,...(payload===undefined?{}:{payload})})+'\n';
  if(Buffer.byteLength(request)>64*1024)throw Error('The setup request exceeds its safe limit.');
  return new Promise((resolve,reject)=>{
   const child=spawn(join(this.resourcePath,'bridge','PackProof.Connect.Bridge.exe'),[],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:process.env.SystemRoot,PATH:process.env.SystemRoot+'\\System32'}});
   let output='',settled=false;const timer=setTimeout(()=>finish(Error('The background service did not respond. Open diagnostics to check its status.')),35000);
   function finish(error?:Error,value?:unknown){if(settled)return;settled=true;clearTimeout(timer);if(error){child.kill();reject(error);}else resolve(value);}
   child.stdout.on('data',bytes=>{output+=bytes.toString('utf8');if(Buffer.byteLength(output)>256*1024)finish(Error('The service response exceeds its safe limit.'));});child.stderr.resume();
   child.on('error',()=>finish(Error('The trusted background service bridge is unavailable. Repair this installation.')));
   child.on('close',code=>{if(settled)return;let reply:any;
    try{reply=JSON.parse(output);if(reply.version!==1||reply.id!==id||typeof reply.ok!=='boolean')throw Error();}catch{finish(Error('The background service could not complete this action. Your pending work is preserved.'));return;}
    if(!reply.ok){const message=typeof reply.error?.message==='string'?reply.error.message.slice(0,400):'The service requires attention.';finish(Error(message));return;}
    if(code!==0){finish(Error('The trusted background service bridge stopped unexpectedly. Pending work is preserved.'));return;}finish(undefined,reply.result);
   });
   child.stdin.on('error',()=>finish(Error('The service bridge closed before receiving the request.')));child.stdin.end(request);
  });
 }
}
