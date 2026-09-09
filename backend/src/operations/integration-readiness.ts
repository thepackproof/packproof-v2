export interface IntegrationCheck { provider:string; status:'CONFIGURED_UNVERIFIED'|'BLOCKED'; issues:string[]; }
const enabled=(value:string|undefined)=>value==='true'||value==='1';
const managed=(value:string|undefined)=>!!value && /(?:^packproof\/|^arn:aws:secretsmanager:)/.test(value);
const https=(value:string|undefined)=>{try{const u=new URL(value!);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}};

/** Configuration admission only. Never equate configured secrets with a successful live order. */
export function integrationReadiness(env:NodeJS.ProcessEnv=process.env) {
  const checks:IntegrationCheck[]=[];
  function check(provider:string,items:Array<[boolean,string]>) {
    const issues=items.filter(([ok])=>!ok).map(([,issue])=>issue);
    checks.push({provider,status:issues.length?'BLOCKED':'CONFIGURED_UNVERIFIED',issues});
  }
  const ns=(ref:string|undefined)=>managed(ref)&&/(?:\/production\/|\/live\/)/.test(ref!);
  check('ebay',[
    [enabled(env.PACKPROOF_EBAY_INTEGRATION_ENABLED),'Enable production eBay integration'],
    [env.PACKPROOF_EBAY_ENVIRONMENT==='production','Switch eBay to production'],
    [!!env.PACKPROOF_EBAY_CLIENT_ID&&!/-SBX-|_SBX_/i.test(env.PACKPROOF_EBAY_CLIENT_ID),'Configure production eBay client ID'],
    [!!env.PACKPROOF_EBAY_RUNAME,'Configure production eBay redirect name'],
    [ns(env.PACKPROOF_EBAY_APP_CREDENTIAL_REFERENCE),'Configure a managed production eBay secret reference'],
  ]);
  for(const provider of ['etsy','shopify']) {
    const prefix=`PACKPROOF_${provider.toUpperCase()}`;
    check(provider,[[enabled(env[`${prefix}_INTEGRATION_ENABLED`]),`Enable ${provider} integration`],
      [!!env[`${prefix}_CLIENT_ID`],`Configure ${provider} application ID`],
      [ns(env[`${prefix}_APP_CREDENTIAL_REFERENCE`]),`Configure a managed live ${provider} secret reference`],
      [https(env.PACKPROOF_PUBLIC_URL),'Configure HTTPS OAuth callback origin']]);
  }
  check('shippo',[[ns(env.PACKPROOF_CAPTURE_SHIPPO_CREDENTIAL_REFERENCE),'Configure a managed live Shippo tracking secret reference'],
    [env.PACKPROOF_LABEL_PURCHASING_ENABLED!=='true','Keep automated label purchasing disabled']]);
  check('aws-cognito',[[env.PACKPROOF_AUTH_MODE==='cognito'&&env.PACKPROOF_DEV_AUTH!=='true','Use Cognito without developer login'],
    [!!env.PACKPROOF_COGNITO_USER_POOL_ID&&!!env.PACKPROOF_COGNITO_CLIENT_ID,'Configure Cognito pool and app client'],
    [env.PACKPROOF_OBJECT_STORAGE==='s3'&&!!env.PACKPROOF_S3_BUCKET,'Configure evidence object storage'],
    [env.PACKPROOF_CREDENTIAL_STORE==='secrets-manager','Use managed integration credentials'],
    [https(env.PACKPROOF_PUBLIC_URL),'Configure HTTPS API origin']]);
  check('zendesk',[[env.PACKPROOF_ZENDESK_WORKSPACE_VERIFIED==='true','Install sidebar and verify its claims-only secure setting in Zendesk']]);
  return {status:checks.some(c=>c.status==='BLOCKED')?'BLOCKED':'CONFIGURED_UNVERIFIED',checks,liveValidation:'REQUIRED',billableActionsEnabled:false};
}

export function assertRealDataRuntime(env:NodeJS.ProcessEnv=process.env) {
  if(!['staging','production'].includes(env.PACKPROOF_ENVIRONMENT??''))return;
  if(enabled(env.PACKPROOF_DEV_AUTH))throw new Error('Developer authentication is unavailable in staging and production');
  if(enabled(env.PACKPROOF_EBAY_INTEGRATION_ENABLED??env.EBAY_INTEGRATION_ENABLED) && (env.PACKPROOF_EBAY_ENVIRONMENT??env.EBAY_ENVIRONMENT??'sandbox')!=='production')
    throw new Error('Staging and production require live eBay credentials; keep eBay disabled until configured');
}
