import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import {spawn} from 'node:child_process';
assert.equal(process.env.PACKPROOF_TEST_PURPOSE,'isolated-m1-synthetic');
assert.equal(process.env.PACKPROOF_DB_NAME,'m1_service_20261021');
const configuration=JSON.parse(process.env.ISOLATED_CONFIGURATION??'{}');delete process.env.ISOLATED_CONFIGURATION;
const allowed=['PACKPROOF_UPLOAD_SECRET','PACKPROOF_EVENT_CURSOR_KEY','PACKPROOF_WEBHOOK_ENCRYPTION_KEY','PACKPROOF_READINESS_OBJECT_KEY','PACKPROOF_READINESS_OBJECT_VERSION'];
for(const [name,value] of Object.entries(configuration)){assert.ok(allowed.includes(name));assert.equal(typeof value,'string');process.env[name]=value;}
const tls=process.env.ISOLATED_TLS?JSON.parse(process.env.ISOLATED_TLS):null;delete process.env.ISOLATED_TLS;
const child=spawn(process.execPath,['dist/index.js'],{stdio:'inherit',env:process.env});
let server;
if(process.env.PACKPROOF_PROCESS_ROLE==='api'){
 assert.ok(tls?.key&&tls?.cert);
 server=https.createServer({key:tls.key,cert:tls.cert,minVersion:'TLSv1.2'},(req,res)=>{
  const upstream=http.request({hostname:'127.0.0.1',port:3000,path:req.url,method:req.method,headers:req.headers},response=>{
   // Revocation aborts an already-started package. Propagate the truncation
   // without turning an expected upstream reset into an uncaught exception.
   response.on('error',()=>res.destroy());
   res.writeHead(response.statusCode??502,response.headers);response.pipe(res);
  });
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
  req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
 });server.requestTimeout=120000;server.listen(3443,'0.0.0.0');
}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server?.close();child.kill(signal);});
child.on('exit',(code,signal)=>{server?.close();process.exit(code??(signal?1:0));});
