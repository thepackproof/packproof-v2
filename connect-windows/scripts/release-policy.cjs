const {execFileSync}=require('node:child_process');
const {readFileSync}=require('node:fs');
const {resolve}=require('node:path');
const {windowsSigningOptions}=require('../../desktop/scripts/release-policy.cjs');
const channels=['development','staging','production'];
function context(env=process.env){
 const channel=env.APP_ENV||'development';if(!channels.includes(channel))throw Error('Unknown Connect environment');
 const label=channel==='production'?'':channel==='staging'?' Staging':' Development';
 return {channel,appId:`com.thepackproof.connect.${channel}`,productName:`PackProof Connect${label}`,serviceName:`PackProofConnect${channel[0].toUpperCase()+channel.slice(1)}`,pipeName:`PackProofConnect-${channel}-v1`,output:`release/${channel}/win32-x64`,updateUrl:`https://downloads.thepackproof.com/connect/${channel}/win32/x64/`};
}
function trustedUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&!u.port&&u.pathname==='/';}catch{return false;}}
function validate(env=process.env,platform=process.platform,{native=false}={}){
 const c=context(env);if(c.channel!=='development'){
  if(platform!=='win32')throw Error('Signed Connect builds require native Windows');
  for(const k of ['PACKPROOF_API_BASE_URL','PACKPROOF_WEB_BASE_URL','WINDOWS_PUBLISHER_NAME'])if(!env[k])throw Error(`${k} is required`);
  if(!trustedUrl(env.PACKPROOF_API_BASE_URL)||!trustedUrl(env.PACKPROOF_WEB_BASE_URL))throw Error('Connect endpoints must be HTTPS origins');
  if(new URL(env.PACKPROOF_WEB_BASE_URL).hostname!=='thepackproof.com')throw Error('Connect approval origin must be thepackproof.com');
  if(env.PACKPROOF_UPDATES_URL!==c.updateUrl)throw Error('Connect update feed must match its environment');
  const provider=env.PACKPROOF_WINDOWS_SIGNING_PROVIDER||'pfx';
  if(provider==='pfx'){for(const k of ['WIN_CSC_LINK','WIN_CSC_KEY_PASSWORD'])if(!env[k])throw Error(`${k} is required`);}
  else if(provider==='azure'){for(const k of ['AZURE_TRUSTED_SIGNING_ENDPOINT','AZURE_TRUSTED_SIGNING_ACCOUNT','AZURE_TRUSTED_SIGNING_PROFILE','AZURE_CLIENT_ID','AZURE_TENANT_ID','AZURE_SUBSCRIPTION_ID'])if(!env[k])throw Error(`${k} is required`);}
  else throw Error('Unsupported signing provider');
 }
 if(native){
  const r=JSON.parse(readFileSync(resolve('dist/main/runtime-config.json')));
  if(r.channel!==c.channel||r.apiBaseUrl!==(env.PACKPROOF_API_BASE_URL||'')||r.webBaseUrl!==(env.PACKPROOF_WEB_BASE_URL||'https://thepackproof.com'))throw Error('Rebuild Connect for the selected environment');
  const service=JSON.parse(readFileSync(resolve('native/service/service-config.json'))),bridge=JSON.parse(readFileSync(resolve('native/bridge/bridge-config.json')));
  if(service.environment!==(c.channel==='production'?'live':c.channel)||service.apiOrigin!==r.apiBaseUrl||service.webOrigin!==r.webBaseUrl||bridge.channel!==c.channel||bridge.publisher!==r.publisher)throw Error('Republish native components for the selected environment');
  if(c.channel!=='development'&&execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())throw Error('Signed Connect packages require committed source');
 }
 return c;
}
function sourceCommit(){return execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();}
module.exports={context,validate,trustedUrl,windowsSigningOptions,sourceCommit};
if(require.main===module){validate(process.env,process.platform,{native:process.argv.includes('--runtime')});process.stdout.write('Connect release configuration accepted.\n');}
