/** Short ECS command transport for the reviewed, separately pinned operator bundle. */
export function validateAdminOperatorRequest(request) {
  const fail=()=>{throw new Error('ADMIN_OPERATOR_REQUEST_INVALID');};
  if(!request||Object.keys(request).sort().join(',')!=='args,bundleSha256,entry,url')fail();
  const {url,bundleSha256,entry,args}=request;let parsed;
  try{parsed=new URL(url);}catch{fail();}
  if(typeof url!=='string'||url.length>4096||parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||parsed.hash||
    parsed.hostname!=='packproof-v2-staging-build-784514617543.s3.us-east-1.amazonaws.com'||
    !/^\/admin\/[a-f0-9]{40}\/operator-bundle\.json\.gz$/.test(parsed.pathname)||!/^[a-f0-9]{64}$/.test(bundleSha256))fail();
  if(!Array.isArray(args)||!['--inspect','--apply'].includes(args[0])||!/^[a-f0-9]{40}$/.test(args[1]??''))fail();
  if(entry==='admin-dashboard-migration.mjs'){if(args.length!==2)fail();}
  else if(entry==='admin-runtime-credentials.mjs'){
    if(args.length!==5||!/^[a-f0-9]{64}$/.test(args[2])||!/^[a-f0-9]{64}$/.test(args[3])||args[4]!=='$RUNTIME_ROLES_SQL')fail();
  }else fail();
  if(args.some(value=>typeof value!=='string'))fail();
}

/** Dependencies are local-test seams; the generated command supplies none. */
export async function executeAdminOperator(request,dependencies={}) {
  let directory;
  const fs=await import('node:fs/promises');
  try{
    validateAdminOperatorRequest(request);
    const [{createHash},{gunzipSync},{pathToFileURL}]=await Promise.all([import('node:crypto'),import('node:zlib'),import('node:url')]);
    const sha=value=>createHash('sha256').update(value).digest('hex');
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),dependencies.timeoutMs??15000);
    let compressed;
    try{
      const response=await(dependencies.fetchImpl??fetch)(request.url,{redirect:'error',signal:controller.signal,headers:{'Accept-Encoding':'identity'}});
      if(response.status!==200||response.redirected||!response.body||Number(response.headers.get('content-length')??0)>131072||
        !['','identity'].includes(response.headers.get('content-encoding')??''))throw 0;
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{
        for(;;){controller.signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;
          size+=value.byteLength;if(size>131072)throw 0;chunks.push(value);
        }
        controller.signal.throwIfAborted();compressed=Buffer.concat(chunks,size);
      }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    }finally{controller.abort();clearTimeout(timer);}
    if(sha(compressed)!==request.bundleSha256)throw 0;
    const bytes=gunzipSync(compressed,{maxOutputLength:524288});
    const utf8=new TextDecoder('utf-8',{fatal:true});
    const bundle=JSON.parse(utf8.decode(bytes));
    const names=['admin-dashboard-migration.mjs','admin-runtime-credentials.mjs','runtime-roles.sql'];
    if(!bundle||Object.keys(bundle).join(',')!=='files'||!Array.isArray(bundle.files)||bundle.files.length!==3)throw 0;
    const files=new Map();
    for(const file of bundle.files){
      if(!file||Object.keys(file).sort().join(',')!=='content,name,sha256'||!names.includes(file.name)||files.has(file.name)||
        typeof file.content!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256??''))throw 0;
      const content=Buffer.from(file.content,'utf8');
      if(utf8.decode(content)!==file.content||sha(content)!==file.sha256)throw 0;
      files.set(file.name,content);
    }
    directory=await fs.mkdtemp('/tmp/packproof-admin-');
    for(const [name,content]of files)await fs.writeFile(`${directory}/${name}`,content,{flag:'wx',mode:0o600});
    if(request.entry==='admin-dashboard-migration.mjs'){
      const {loadConfig}=await(dependencies.importConfig??(()=>import('/app/dist/config.js')))();
      const databaseUrl=loadConfig({...process.env,PACKPROOF_DB_SECRET_ARN:''}).databaseUrl;
      if(typeof databaseUrl!=='string'||!databaseUrl)throw 0;
      process.env.PACKPROOF_ADMIN_MIGRATION_DATABASE_URL=databaseUrl;
      process.env.PACKPROOF_DB_SECRET_ARN='';
      process.env.PACKPROOF_ADMIN_MIGRATION_DB_SECRET_ARN='';
    }
    const module=await(dependencies.importModule??(url=>import(url)))(pathToFileURL(`${directory}/${request.entry}`).href);
    if(typeof module.main!=='function')throw 0;
    await module.main(request.args.map(arg=>arg==='$RUNTIME_ROLES_SQL'?`${directory}/runtime-roles.sql`:arg));
  }catch{throw new Error('ADMIN_OPERATOR_FAILED');}
  finally{
    if(directory)try{await fs.rm(directory,{recursive:true,force:true});}catch{throw new Error('ADMIN_OPERATOR_FAILED');}
  }
}

/** Pass the returned array as ECS command values; never interpolate through a shell. */
export function buildAdminOperatorCommand(request) {
  validateAdminOperatorRequest(request);
  const source=`${validateAdminOperatorRequest.toString()}\n${executeAdminOperator.toString()}\ntry{await executeAdminOperator(${JSON.stringify(request)});}catch{console.log(JSON.stringify({event:'admin_operator_failed',code:'ADMIN_OPERATOR_FAILED'}));process.exitCode=1;}`;
  const command=['node','--input-type=module','-e',source];
  // Leave space for the container name and environment in the actual override.
  if(Buffer.byteLength(JSON.stringify({containerOverrides:[{name:'packproof-api',command}]}))>=8000)throw new Error('ADMIN_OPERATOR_COMMAND_TOO_LARGE');
  return command;
}
