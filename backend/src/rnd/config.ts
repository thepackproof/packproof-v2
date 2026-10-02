import { DomainError } from '../domain/errors.js';
import { FEATURES,type Feature,type Operation,type RndConfig } from './types.js';
import { readRndFlags } from '../../../packages/evidence-contracts/contracts.mjs';
import { loadPlatformAssuranceConfig } from './platform-assurance-service.js';

export function rndConfigFromEnv(env:NodeJS.ProcessEnv=process.env):RndConfig {
 const flags=readRndFlags(env),{enabled,killSwitch,features}=flags;
 const environment=enabled?'research':'disabled';
 if(enabled&&(['production','staging','prod'].includes(env.PACKPROOF_ENVIRONMENT??'')||env.NODE_ENV==='production'))
  throw new Error('Experimental R&D cannot run in production or staging');
 // No customer profile has completed physical/hardware/privacy qualification in this branch.
 if(FEATURES.some(f=>features[f].customerDisplay))throw new Error('Customer display has no approved qualification record');
 const script=env.PACKPROOF_RND_WORKER_SCRIPT;
 const modelPath=env.PACKPROOF_RND_PROOFSIGHT_MODEL_PATH,modelSha=env.PACKPROOF_RND_PROOFSIGHT_MODEL_SHA256,modelRelease=env.PACKPROOF_RND_PROOFSIGHT_MODEL_RELEASE_ID;
 if((modelPath||modelSha||modelRelease)&&(!modelPath||!modelSha||!modelRelease||!/^([a-f0-9]{64})$/.test(modelSha)||!/^[a-zA-Z0-9_.:-]{1,120}$/.test(modelRelease)))throw new Error('A ProofSight model needs a server-pinned path, SHA256 and release ID');
 const sandbox=env.PACKPROOF_RND_SANDBOX_EXECUTABLE?{program:env.PACKPROOF_RND_SANDBOX_EXECUTABLE,args:JSON.parse(env.PACKPROOF_RND_SANDBOX_ARGS??'[]') as string[]}:undefined;
 if(sandbox&&(!Array.isArray(sandbox.args)||sandbox.args.length>16||sandbox.args.some(v=>typeof v!=='string'||v.length>1024)))throw new Error('Invalid worker sandbox command arguments');
 const trustedPublicKeysHex=env.PACKPROOF_RND_LEARNING_TRUST_KEYS?.split(',').map(s=>s.trim()).filter(Boolean)??[];
 if(trustedPublicKeysHex.some(k=>!/^([a-f0-9]{64})$/.test(k)))throw new Error('Learning trust pins must be Ed25519 public keys in hex');
 const witness=env.PACKPROOF_RND_WITNESS_SCRIPT;
 const operators=env.PACKPROOF_RND_WITNESS_OPERATORS?JSON.parse(env.PACKPROOF_RND_WITNESS_OPERATORS) as {operatorId:string;keyFile:string;stateDb:string}[]:undefined;
 if(operators&&(!Array.isArray(operators)||operators.length!==2||new Set(operators.map(o=>o.operatorId)).size!==2||operators.some(o=>!o||typeof o.operatorId!=='string'||!/^[a-zA-Z0-9_.:-]{1,120}$/.test(o.operatorId)||typeof o.keyFile!=='string'||typeof o.stateDb!=='string'||!o.keyFile||!o.stateDb)))throw new Error('Controlled witness research requires exactly two distinct named local operators');
 const zk=env.PACKPROOF_RND_ZK_SCRIPT;
 if(zk&&![env.PACKPROOF_RND_ZK_VERIFICATION_REGISTRY,env.PACKPROOF_RND_ZK_SOURCE_PRIVATE_KEY,env.PACKPROOF_RND_ZK_SOURCE_PUBLIC_KEY].every(Boolean))throw new Error('ZK research requires pinned verification registry and isolated source signing keys');
 if(witness&&![env.PACKPROOF_RND_WITNESS_DB,env.PACKPROOF_RND_WITNESS_KEY,env.PACKPROOF_RND_WITNESS_LOG_ID,env.PACKPROOF_RND_WITNESS_POLICY].every(Boolean))throw new Error('Witness requires an isolated private log, key, ID, and pinned trust policy');
 return {enabled,killSwitch,environment,features,...(enabled?{platform:loadPlatformAssuranceConfig(env)}:{}),
  ...(zk?{zk:{node:env.PACKPROOF_RND_ZK_NODE??'node',script:zk,verificationRegistryFile:env.PACKPROOF_RND_ZK_VERIFICATION_REGISTRY!,sourcePrivateKeyFile:env.PACKPROOF_RND_ZK_SOURCE_PRIVATE_KEY!,sourcePublicKeyFile:env.PACKPROOF_RND_ZK_SOURCE_PUBLIC_KEY!,timeoutMs:120000,...(sandbox?{sandbox}:{})}}:{}),
  ...(script?{worker:{python:env.PACKPROOF_RND_PYTHON??'python3',script,timeoutMs:60000,maxInputBytes:128*1024*1024,...(sandbox?{sandbox}:{}),...(modelPath?{proofsightModel:{path:modelPath,sha256:modelSha!,releaseId:modelRelease!}}:{})}}:{}),learning:{trustedPublicKeysHex},
  ...(witness?{witness:{python:env.PACKPROOF_RND_WITNESS_PYTHON??env.PACKPROOF_RND_PYTHON??'python3',script:witness,logDb:env.PACKPROOF_RND_WITNESS_DB!,logKey:env.PACKPROOF_RND_WITNESS_KEY!,logId:env.PACKPROOF_RND_WITNESS_LOG_ID!,trustPolicyFile:env.PACKPROOF_RND_WITNESS_POLICY!,...(operators?{operators}:{})}}:{})};
}
export function requireRnd(config:RndConfig|undefined,feature:Feature,operation:Operation) {
 if(!config?.enabled||config.killSwitch||!['research','test'].includes(config.environment)||!config.features[feature]?.[operation])
  throw new DomainError('RND_DISABLED','This experimental capability is disabled',404);
}
export function enabledResearchConfig():RndConfig {
 return {enabled:true,killSwitch:false,environment:'test',features:Object.fromEntries(FEATURES.map(f=>[f,{collection:true,processing:true,internalDisplay:true,customerDisplay:false}])) as RndConfig['features']};
}
