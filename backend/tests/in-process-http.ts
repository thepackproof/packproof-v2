import {IncomingMessage,ServerResponse} from 'node:http';
import {Duplex} from 'node:stream';
import type {Socket} from 'node:net';
import type {Express} from 'express';

/** Real Express middleware/response handling without opening a network listener. */
export default function request(app:Express){
 const make=(method:string,path:string)=>{
  const headers:Record<string,string>={};let body:unknown;
  const chain={
   set(name:string|Record<string,string>,value?:string){if(typeof name==='string')headers[name.toLowerCase()]=value!;else for(const [k,v]of Object.entries(name))headers[k.toLowerCase()]=v;return chain;},
   query(values:Record<string,string>){path+=`${path.includes('?')?'&':'?'}${new URLSearchParams(values)}`;return chain;},
   send(value:unknown){body=value;return chain;},
   then<TResult1=HttpResult,TResult2=never>(fulfilled?:((v:HttpResult)=>TResult1|PromiseLike<TResult1>)|null,rejected?:((e:unknown)=>TResult2|PromiseLike<TResult2>)|null){
    return new Promise<HttpResult>((resolve,reject)=>{
     const socket=new Duplex({read(){},write(_chunk,_encoding,done){done();}});
     const req=new IncomingMessage(socket as Socket);req.method=method;req.url=path;req.headers=headers;
     const bytes=body===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(body));
     if(body!==undefined){headers['content-type']='application/json';headers['content-length']=String(bytes.length);}
     const res=new ServerResponse(req),chunks:Buffer[]=[];res.assignSocket(socket as Socket);
     const write=res.write.bind(res),end=res.end.bind(res);
     const complete=()=>{const text=Buffer.concat(chunks).toString();let parsed:unknown;try{parsed=JSON.parse(text);}catch{parsed=text;}resolve({status:res.statusCode,text,body:parsed,headers:res.getHeaders()});};
     res.write=((chunk:unknown,...args:unknown[])=>{if(chunk)chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk)));return (write as Function)(chunk,...args);}) as typeof res.write;
     res.end=((chunk:unknown,...args:unknown[])=>{if(chunk&&typeof chunk!=='function')chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk)));complete();return (end as Function)(chunk,...args);}) as typeof res.end;
     res.on('error',reject);res.on('finish',()=>socket.destroy());
     app(req,res);req.push(bytes.length?bytes:null);if(bytes.length)req.push(null);
    }).then(fulfilled,rejected);
   }
  };return chain;
 };
 return {get:(p:string)=>make('GET',p),post:(p:string)=>make('POST',p),delete:(p:string)=>make('DELETE',p)};
}
interface HttpResult {status:number;text:string;body:any;headers:ReturnType<ServerResponse['getHeaders']>}
