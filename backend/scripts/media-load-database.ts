import {createPgliteDatabase} from '../src/db/pglite.js';
import {migrate} from '../src/db/migrate.js';
import type {Database} from '../src/db/database.js';
import {readFile} from 'node:fs/promises';

// The deployment uses external PostgreSQL. Keep this local DB service outside
// the API/media process being measured; it is explicitly not a PG capacity test.
const opened=await createPgliteDatabase(process.argv[2]);await migrate(opened.db);
let tail:Promise<unknown>=Promise.resolve();
let active:{id:string;tx:Database;finish:(error?:Error)=>void;end?:Message}|null=null;
type Message={clientId:number;id:number;method:'query'|'begin'|'commit'|'rollback';sql?:string;params?:unknown[];transactionId?:string};
const reply=(m:Message,result:unknown,error?:unknown)=>process.send?.({type:'db-result',clientId:m.clientId,id:m.id,result,...(error?{error:{message:String((error as Error).message),code:(error as {code?:string}).code}}:{})});
const schedule=(fn:()=>Promise<unknown>)=>{const result=tail.then(fn,fn);tail=result.catch(()=>undefined);return result;};
process.on('message',(m:Message|{method:'close'})=>{
  if(m.method==='close'){void tail.finally(async()=>{await opened.close();process.exit(0);});return;}
  if(m.method==='begin'){
    void schedule(async()=>{
      let begun=false;
      try{await opened.db.transaction(async tx=>{await new Promise<void>((resolve,reject)=>{const transactionId=`${m.clientId}:${m.id}`;active={id:transactionId,tx,finish:error=>error?reject(error):resolve()};begun=true;reply(m,{transactionId});});});if(active?.end)reply(active.end,{});}
      catch(error){if(active?.end&&active.end.method==='rollback')reply(active.end,{});else reply(active?.end??m,null,error);}
      finally{active=null;}
      return begun;
    });return;
  }
  if(m.method==='commit'||m.method==='rollback'){
    if(!active||active.id!==m.transactionId){reply(m,null,new Error('Invalid load DB transaction'));return;}
    active.end=m;active.finish(m.method==='rollback'?new Error('Requested rollback'):undefined);return;
  }
  const query=()=>opened.db.query(m.sql!,m.params??[]);
  const job=m.transactionId
    ?active?.id===m.transactionId?active.tx.query(m.sql!,m.params??[]):Promise.reject(new Error('Invalid load DB transaction'))
    :schedule(query);
  void job.then(result=>reply(m,result),error=>reply(m,null,error));
});
const status=await readFile('/proc/self/status','utf8');
process.send?.({type:'ready',hostPid:Number(/^Pid:\s+(\d+)/m.exec(status)?.[1])});
