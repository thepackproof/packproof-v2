import { existsSync,readFileSync } from 'node:fs';
import type { AppConfig } from '../config.js';
import type { RndConfig } from './types.js';

/** Invoked before any signing, database, integration or object-store initializer. */
export function assertResearchRuntimeIsolation(config:AppConfig,rnd:RndConfig,env:NodeJS.ProcessEnv=process.env,markerPath=new URL('../../../config/rnd/research-build.json',import.meta.url)) {
 let marked=false;
 if(existsSync(markerPath)){let marker:Record<string,unknown>;try{marker=JSON.parse(readFileSync(markerPath,'utf8'));}catch{throw new Error('Research build policy is unreadable; refusing runtime startup');}marked=marker.researchOnly!==false;}
 if(!marked&&!rnd.enabled)return;
 const reject=(condition:boolean,detail:string)=>{if(condition)throw new Error(`Research runtime isolation: ${detail}`);};
 reject(env.PACKPROOF_ENV!=='research'||config.release.environment!=='research','set the isolated research environment explicitly');
 reject(config.objectStore!=='local'||!!config.awsS3Bucket,'only private local object storage is enabled in this research build');
 reject(config.authMode!=='dev'||!config.devAuth||!!config.cognitoUserPoolId||!!config.cognitoClientId,'use local development identities');
 reject(config.credentialStore!=='memory','use the in-memory research credential store');
 reject(!/(?:^|[\/_.-])(rnd|research)(?:[\/_.-]|$)/i.test(config.pgliteDir),'choose an explicit research data directory');
 const localUrl=(value:string)=>{try{const u=new URL(value);return ['localhost','127.0.0.1','[::1]'].includes(u.hostname)&&!u.username&&!u.password;}catch{return false;}};
 reject(!localUrl(config.publicBaseUrl)||config.webOrigins.some(o=>!localUrl(o)),'API and web origins must be loopback addresses');
 if(config.databaseUrl){let valid=false;try{const u=new URL(config.databaseUrl);valid=['postgres:','postgresql:'].includes(u.protocol)&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)&&/^\/packproof_(rnd|research)(?:_|$)/.test(u.pathname);}catch{/* fail closed */}reject(!valid,'database must be local and use an explicit packproof_rnd or packproof_research name');}
 reject([config.ebay,config.shopify,config.etsy,config.google,config.facebook].some(p=>p.enabled),'commerce and social integrations must be disabled');
 reject(config.requireDurableReceipts===true||env.PACKPROOF_RECOVERY_WORKER==='true'||!!env.PACKPROOF_RECOVERY_S3_BUCKET||!!env.PACKPROOF_RECOVERY_KMS_KEY_ARN,'cloud recovery workers are unavailable in research');
 reject(env.PACKPROOF_MANIFEST_SIGNING_MODE==='kms'||!!env.PACKPROOF_MANIFEST_KMS_KEY_ARN,'use a dedicated local research signing key');
 if(env.PACKPROOF_MANIFEST_SIGNING_MODE==='pem')reject(!/^(research|rnd)[-:/_]/.test(env.PACKPROOF_MANIFEST_SIGNING_KEY_ID??''),'signing key ID must explicitly identify the research namespace');
 const forbidden=['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_PROFILE','AWS_CONTAINER_CREDENTIALS_FULL_URI','AWS_CONTAINER_CREDENTIALS_RELATIVE_URI','AWS_WEB_IDENTITY_TOKEN_FILE','STRIPE_SECRET_KEY','PACKPROOF_STRIPE_SECRET_KEY','SHIPPO_API_KEY','EASYPOST_API_KEY','PACKPROOF_EASYPOST_API_KEY','PACKPROOF_SHIPPO_API_TOKEN','PACKPROOF_SMTP_PASSWORD'];
 reject(forbidden.some(name=>Boolean(env[name])),'remove inherited cloud, billing, carrier and mail credentials');
}
