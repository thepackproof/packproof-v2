// One-shot check of the qualified image with the service's existing production
// configuration. Invalid enrollment input and unauthenticated reads create no
// installation, human approval, source binding or shipment record.
const fail=code=>{throw Error(code);};
const source='3bff0173c9d91fc11ae614d72872b877628c327d';
const image='sha256:3b1c81642b27a14629a5a8c8f4af4b0bf91f09bc0e0b5591e06af10d5bde0557';
const host='packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com';
let phase='binding';
const deadline=setTimeout(()=>process.exit(2),180000);deadline.unref();
try{
 const e=process.env,remaining=Date.parse(e.ZERO_TOUCH_LIVE_PROBE_EXPIRES_AT)-Date.now();
 if(!Number.isFinite(remaining)||remaining<=0||remaining>3600000||e.PACKPROOF_PROCESS_ROLE!=='api'||e.PACKPROOF_ENVIRONMENT!=='production'||e.PACKPROOF_MIGRATE_ON_START!=='false'||e.PACKPROOF_RELEASE_SHA!==source||!e.PACKPROOF_RELEASE_IMAGE?.endsWith('@'+image))fail('LIVE_STARTUP_BINDING_REQUIRED');
 const {loadConfig}=await import('/app/backend/dist/config.js');
 const config=loadConfig(),url=new URL(config.databaseUrl);
 if(url.hostname!==host||url.pathname!=='/packproof_v2'||decodeURIComponent(url.username)!=='packproof_records_api_v1'||config.processRole!=='api'||config.migrateOnStart!==false||config.authMode!=='cognito'||config.objectStore!=='s3')fail('LIVE_STARTUP_CONFIGURATION_MISMATCH');
 const metadata=e.ECS_CONTAINER_METADATA_URI_V4;
 if(!/^http:\/\/169\.254\.170\.2\/v4\/[a-zA-Z0-9_/-]+$/.test(metadata??''))fail('LIVE_STARTUP_METADATA_REQUIRED');
 const get=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(10000)});if(!r.ok)fail('LIVE_STARTUP_METADATA_FAILED');return r.json();};
 const [container,task]=await Promise.all([get(metadata),get(metadata+'/task')]);
 if(container.ImageID!==image||!/^arn:aws:ecs:us-east-1:784514617543:task\/packproof-v2-staging-cluster\/[a-f0-9]{32}$/.test(task.TaskARN??''))fail('LIVE_STARTUP_ACTUAL_IMAGE_MISMATCH');
 phase='startup';await import('/app/backend/dist/index.js');
 const checks=[];
 for(const [route,status,method] of [['/meta',200,'GET'],['/health',200,'GET'],['/ready',200,'GET'],['/me/capabilities',401,'GET'],['/me/records/agent-installations',401,'GET'],['/connect/enrollments',400,'POST']]){
  phase='http:'+route;let response;
  for(let attempt=0;attempt<20;attempt++){
   try{response=await fetch(`http://127.0.0.1:${config.port}${route}`,{method,headers:{Origin:'https://thepackproof.com',...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:'{}'}:{}),signal:AbortSignal.timeout(10000)});break;}
   catch(error){if(attempt===19)throw error;await new Promise(resolve=>setTimeout(resolve,250));}
  }
  const body=await response.json(),cors=response.headers.get('access-control-allow-origin');
  if(response.status!==status||cors!=='https://thepackproof.com'){
   console.error(JSON.stringify({event:'zero_touch_live_startup_http_failure',route,status:response.status,cors,readiness:route==='/ready'?body:undefined}));fail('LIVE_STARTUP_HTTP_FAILED');
  }
  if(route==='/meta'&&(body.commit!==source||body.image!==e.PACKPROOF_RELEASE_IMAGE))fail('LIVE_STARTUP_PUBLIC_IDENTITY_MISMATCH');
  checks.push({route,method,status:response.status,cors});
 }
 console.log(JSON.stringify({event:'zero_touch_live_startup_verified',schema:'packproof.zero-touch-live-startup/v1',status:'PASSED',source,image,taskArn:task.TaskARN,targetHost:host,checks,workersStarted:false,customerSourcesActivated:false,completedAt:new Date().toISOString()}));
 clearTimeout(deadline);process.kill(process.pid,'SIGTERM');
}catch(error){
 console.error(JSON.stringify({event:'zero_touch_live_startup_failed',phase,code:/^[A-Z0-9_]{3,90}$/.test(error?.message??'')?error.message:'LIVE_STARTUP_FAILED',sqlState:/^[0-9A-Z]{5}$/.test(error?.code??'')?error.code:undefined}));
 clearTimeout(deadline);process.exit(1);
}
