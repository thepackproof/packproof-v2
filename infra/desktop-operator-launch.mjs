/** Standalone hash-pinned transport for the reviewed desktop074 operator only. */
export function validateDesktopOperatorRequest(request){
  const fail=()=>{throw new Error('DESKTOP_OPERATOR_REQUEST_INVALID');};
  const source='d45727b8648ade030642a011c280c10bce525591';
  if(!request||Object.keys(request).sort().join(',')!=='args,bundleSha256,url')fail();
  let url;try{url=new URL(request.url);}catch{fail();}
  if(typeof request.url!=='string'||request.url.length>4096||url.protocol!=='https:'||url.username||url.password||url.port||url.hash||url.hostname!=='packproof-v2-staging-build-784514617543.s3.us-east-1.amazonaws.com'||url.pathname!==`/desktop/${source}/operator-bundle.json.gz`||!/^[a-f0-9]{64}$/.test(request.bundleSha256??''))fail();
  if(!Array.isArray(request.args)||request.args.length!==2||!['--inspect','--apply'].includes(request.args[0])||request.args[1]!==source)fail();
  if(request.url.split('?')[0]!==`https://packproof-v2-staging-build-784514617543.s3.us-east-1.amazonaws.com/desktop/${source}/operator-bundle.json.gz`)fail();
}
/** Test seams are not included in operator commands. No logs contain URLs or credentials. */
export async function executeDesktopOperator(request,dependencies={}){
  let directory;const fs=await import('node:fs/promises');
  const keys=['PACKPROOF_DESKTOP_MIGRATION_DATABASE_URL','PACKPROOF_DESKTOP_MIGRATION_DB_SECRET_ARN','PACKPROOF_DB_SECRET_ARN'];
  const prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try{
    validateDesktopOperatorRequest(request);
    const [{createHash},{gunzipSync},{pathToFileURL}]=await Promise.all([import('node:crypto'),import('node:zlib'),import('node:url')]);
    const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),dependencies.timeoutMs??15000);
    let compressed;
    try{
      const response=await(dependencies.fetchImpl??fetch)(request.url,{redirect:'error',signal:controller.signal,headers:{'Accept-Encoding':'identity'}});
      if(response.status!==200||response.redirected||!response.body||Number(response.headers.get('content-length')??0)>131072||!['','identity'].includes(response.headers.get('content-encoding')??''))throw 0;
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{for(;;){controller.signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>131072)throw 0;chunks.push(value);}controller.signal.throwIfAborted();compressed=Buffer.concat(chunks,size);}
      finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    }finally{controller.abort();clearTimeout(timer);}
    if(sha(compressed)!==request.bundleSha256)throw 0;
    const utf8=new TextDecoder('utf-8',{fatal:true}),bundle=JSON.parse(utf8.decode(gunzipSync(compressed,{maxOutputLength:524288})));
    if(!bundle||Object.keys(bundle).join(',')!=='files'||!Array.isArray(bundle.files)||bundle.files.length!==1)throw 0;
    const file=bundle.files[0];
    if(!file||Object.keys(file).sort().join(',')!=='content,name,sha256'||file.name!=='desktop-capture-migration.mjs'||typeof file.content!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256??''))throw 0;
    const content=Buffer.from(file.content,'utf8');if(utf8.decode(content)!==file.content||sha(content)!==file.sha256)throw 0;
    // The dedicated operator task injects owner components through its execution
    // role. Never select an ambient runtime URL, callback, or task-role secret.
    if(process.env.PACKPROOF_DESKTOP_MIGRATION_OPERATOR!=='OWNER_COMPONENTS_INJECTED'||process.env.PACKPROOF_DB_USER!=='packproof'||!process.env.PACKPROOF_DB_PASSWORD)throw 0;
    const {loadConfig}=await(dependencies.importConfig??(()=>import('/app/dist/config.js')))();
    const databaseUrl=loadConfig({...process.env,DATABASE_URL:'',PACKPROOF_DB_SECRET_ARN:''}).databaseUrl;
    if(typeof databaseUrl!=='string'||!databaseUrl)throw 0;
    process.env.PACKPROOF_DESKTOP_MIGRATION_DATABASE_URL=databaseUrl;
    process.env.PACKPROOF_DESKTOP_MIGRATION_DB_SECRET_ARN='';process.env.PACKPROOF_DB_SECRET_ARN='';
    directory=await fs.mkdtemp('/tmp/packproof-desktop-operator-');
    await fs.writeFile(`${directory}/${file.name}`,content,{flag:'wx',mode:0o600});
    const module=await(dependencies.importModule??(url=>import(url)))(pathToFileURL(`${directory}/${file.name}`).href);
    if(typeof module.main!=='function')throw 0;
    await module.main(request.args);
  }catch{throw new Error('DESKTOP_OPERATOR_FAILED');}
  finally{
    for(const key of keys)if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];
    if(directory)try{await fs.rm(directory,{recursive:true,force:true});}catch{throw new Error('DESKTOP_OPERATOR_FAILED');}
  }
}
/** Structured ECS command; no shell interpolation. Caller separately pins task/image and operator bundle. */
export function buildDesktopOperatorCommand(request){
  validateDesktopOperatorRequest(request);
  const source=`${validateDesktopOperatorRequest.toString()}\n${executeDesktopOperator.toString()}\ntry{await executeDesktopOperator(${JSON.stringify(request)});}catch{console.log(JSON.stringify({event:'desktop_operator_failed',code:'DESKTOP_OPERATOR_FAILED'}));process.exitCode=1;}`;
  const command=['node','--input-type=module','-e',source];
  if(Buffer.byteLength(JSON.stringify({containerOverrides:[{name:'packproof-api',command}]}))>=7800)throw new Error('DESKTOP_OPERATOR_COMMAND_TOO_LARGE');
  return command;
}
