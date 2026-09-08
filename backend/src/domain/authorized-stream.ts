import { Readable } from "node:stream";
import { DomainError } from "./errors.js";

/** An already-open response cannot become a permanent revocation bypass. Storage
 * and HTTP backpressure bound the remaining already-admitted bytes after revoke. */
export function guardAuthorizedStream(source:Readable,authorize:()=>Promise<void>,options:{maximumBytesBetweenChecks?:number;maximumMsBetweenChecks?:number;maximumLifetimeMs?:number;now?:()=>number}={}):Readable {
  const maximumBytes=options.maximumBytesBetweenChecks??1024*1024,maximumMs=options.maximumMsBetweenChecks??1000,maximumLifetime=options.maximumLifetimeMs??10*60*1000,now=options.now??Date.now;
  const started=now();let checkedAt:number|null=null,bytesSinceCheck=0;
  async function* guarded(){
    try{
      for await(const chunk of source){
        const bytes=Buffer.from(chunk);
        for(let offset=0;offset<bytes.length;){
          if(now()-started>=maximumLifetime)throw new DomainError('ACCESS_RESPONSE_EXPIRED','Open the recording again to continue',403);
          if(checkedAt===null||bytesSinceCheck>=maximumBytes||now()-checkedAt>=maximumMs){await authorize();checkedAt=now();bytesSinceCheck=0;}
          const end=Math.min(bytes.length,offset+Math.min(64*1024,maximumBytes-bytesSinceCheck));
          const part=bytes.subarray(offset,end);bytesSinceCheck+=part.length;offset=end;yield part;
        }
      }
    }finally{source.destroy();}
  }
  return Readable.from(guarded(),{objectMode:false,highWaterMark:64*1024});
}
