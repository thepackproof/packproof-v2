#!/usr/bin/env node
/** Private, local-only development runtime. Never inherits service credentials. */
import {createPrivateKey,createPublicKey,generateKeyPairSync,randomBytes} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,statSync,lstatSync,existsSync,realpathSync,openSync,fstatSync,closeSync,constants} from 'node:fs';
import {spawn} from 'node:child_process';
import {resolve,dirname,basename,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FEATURES} from '../packages/evidence-contracts/contracts.mjs';

const root=realpathSync(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
const outsideSource=directory=>{
 if(directory===root||directory.startsWith(root+sep))throw new Error('Private runtime material must be outside the source repository.');
};
const entryExists=file=>{try{lstatSync(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
const privateOwner=info=>process.platform==='win32'||((info.mode&0o077)===0&&info.uid===process.getuid());

/** Resolve the existing ancestor before creating anything, including through parent symlinks. */
function freshDestination(requested) {
 if(entryExists(requested))throw new Error('Choose a new private directory; existing material is never overwritten.');
 let ancestor=dirname(requested);const missing=[basename(requested)];
 while(!entryExists(ancestor)){missing.unshift(basename(ancestor));ancestor=dirname(ancestor);}
 const directory=resolve(realpathSync(ancestor),...missing);
 outsideSource(directory);
 return directory;
}

export function initializeRuntime(directory) {
 const requested=freshDestination(resolve(directory));
 mkdirSync(dirname(requested),{recursive:true,mode:0o700});
 // Resolve again after creating parents, and create the final directory exclusively.
 const destination=resolve(realpathSync(dirname(requested)),basename(requested));
 outsideSource(destination);
 mkdirSync(destination,{mode:0o700});
 if(!privateOwner(statSync(destination)))throw new Error('Runtime directory must be private and owned by this user.');
 const material=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),keyId='research-'+randomBytes(12).toString('hex');
 const trust={schema:'packproof.trust-list.v1',generatedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+30*86400000).toISOString(),keys:[{keyId,algorithm:'ECDSA_SHA_256',status:'ACTIVE',publicKeyPem:material.publicKey.export({type:'spki',format:'pem'}).toString()}]};
 writeFileSync(resolve(destination,'signing-key.pem'),material.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});
 writeFileSync(resolve(destination,'public-trust.json'),JSON.stringify(trust,null,2)+'\n',{mode:0o600,flag:'wx'});
 writeFileSync(resolve(destination,'runtime.json'),JSON.stringify({schemaVersion:'packproof.local-research.v1',keyId,uploadSecret:randomBytes(32).toString('hex')},null,2)+'\n',{mode:0o600,flag:'wx'});
 return destination;
}

function readPrivateFile(directory,name) {
 const file=resolve(directory,name),info=lstatSync(file);
 if(!info.isFile()||!privateOwner(info)||info.nlink!==1||info.size>65536)throw new Error(`Invalid private runtime file: ${name}`);
 const fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const opened=fstatSync(fd);
  if(!opened.isFile()||!privateOwner(opened)||opened.nlink!==1||opened.size>65536||opened.ino!==info.ino||opened.dev!==info.dev)throw new Error(`Invalid private runtime file: ${name}`);
  return readFileSync(fd,'utf8');
 }finally{closeSync(fd);}
}

/** Build the exact child specification; callers never merge the parent environment. */
export function prepareRuntime({directory,port=3000,features=[]},parentEnv=process.env) {
 directory=realpathSync(resolve(directory));outsideSource(directory);
 if(!statSync(directory).isDirectory()||!privateOwner(statSync(directory)))throw new Error('Use a private directory owned by this user outside the repository.');
 // The backend loads cwd/.env. A copied environment file must not restore stripped credentials.
 if(entryExists(resolve(directory,'.env')))throw new Error('Remove the runtime .env file; this launcher supplies an isolated environment.');
 const config=JSON.parse(readPrivateFile(directory,'runtime.json'));
 if(config.schemaVersion!=='packproof.local-research.v1'||!/^research-[a-f0-9]{24}$/.test(config.keyId)||!/^[a-f0-9]{64}$/.test(config.uploadSecret)||Object.keys(config).sort().join(',')!=='keyId,schemaVersion,uploadSecret')throw new Error('Invalid isolated runtime config.');
 const privateKey=createPrivateKey(readPrivateFile(directory,'signing-key.pem'));
 const trust=JSON.parse(readPrivateFile(directory,'public-trust.json'));
 const trusted=trust.keys?.[0];
 if(privateKey.asymmetricKeyType!=='ec'||privateKey.asymmetricKeyDetails?.namedCurve!=='prime256v1'||trust.schema!=='packproof.trust-list.v1'||!Array.isArray(trust.keys)||trust.keys.length!==1||trusted.keyId!==config.keyId||trusted.status!=='ACTIVE'||trusted.algorithm!=='ECDSA_SHA_256'||!Number.isFinite(Date.parse(trust.expiresAt))||Date.parse(trust.expiresAt)<=Date.now()||createPublicKey(privateKey).export({type:'spki',format:'pem'}).toString()!==createPublicKey(trusted.publicKeyPem).export({type:'spki',format:'pem'}).toString())throw new Error('Local signing material and trust policy must match and be current.');
 for(const name of ['research-db','research-db/objects']){
  const path=resolve(directory,name);
  if(entryExists(path)&&(!lstatSync(path).isDirectory()||realpathSync(path)!==path))throw new Error('Research data paths must be local directories without symlinks.');
 }
 port=Number(port);if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('Invalid local port.');
 if(!Array.isArray(features)||features.some(feature=>!FEATURES.includes(feature)))throw new Error('Unknown research feature.');
 const env={PATH:process.platform==='win32'?`${dirname(process.execPath)};C:\\Windows\\System32`:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:directory,NODE_ENV:'development',PORT:String(port),
  PACKPROOF_ENV:'research',PACKPROOF_ENVIRONMENT:'research',PACKPROOF_OBJECT_STORAGE:'local',PACKPROOF_AUTH_MODE:'dev',PACKPROOF_DEV_AUTH:'true',PACKPROOF_CREDENTIAL_STORE:'memory',
  PGLITE_DIR:resolve(directory,'research-db'),PACKPROOF_PUBLIC_URL:`http://127.0.0.1:${port}`,PACKPROOF_WEB_ORIGINS:'http://127.0.0.1:5173,http://localhost:5173',PACKPROOF_UPLOAD_SECRET:config.uploadSecret,
  PACKPROOF_MANIFEST_SIGNING_MODE:'pem',PACKPROOF_MANIFEST_SIGNING_REQUIRED:'true',PACKPROOF_MANIFEST_SIGNING_KEY_ID:config.keyId,PACKPROOF_MANIFEST_SIGNING_ALGORITHM:'ECDSA_SHA_256',PACKPROOF_MANIFEST_SIGNING_KEY_FILE:resolve(directory,'signing-key.pem'),PACKPROOF_MANIFEST_TRUST_LIST_FILE:resolve(directory,'public-trust.json'),
  PACKPROOF_RND_ENABLED:features.length?'1':'0',PACKPROOF_RND_KILL_SWITCH:features.length?'0':'1',PACKPROOF_DISTRIBUTION_AUTHORIZED:'false',PACKPROOF_COMMERCE_WORKER:'false',PACKPROOF_CAPTURE_SHIPMENT_WORKER:'false'};
 for(const feature of features)for(const operation of ['COLLECTION','PROCESSING','INTERNAL_DISPLAY'])env[`PACKPROOF_RND_${feature.toUpperCase()}_${operation}`]='1';
 // Only named local worker settings are inherited. Platform, witness and training service
 // credentials are configured separately; this convenience runner does not copy them.
 for(const name of ['PACKPROOF_RND_PYTHON','PACKPROOF_RND_WORKER_SCRIPT','PACKPROOF_RND_SANDBOX_EXECUTABLE','PACKPROOF_RND_SANDBOX_ARGS'])if(parentEnv[name])env[name]=parentEnv[name];
 return {program:process.execPath,args:[resolve(root,'backend/dist/index.js')],options:{cwd:directory,env,stdio:'inherit',shell:false}};
}

function main(argv) {
 const [command,...args]=argv,values={};
 for(let i=0;i<args.length;i+=2){
  const key=args[i];
  if(!['--dir','--port','--features'].includes(key)||Object.hasOwn(values,key)||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Expected one value for each of --dir, --port and --features.');
  values[key]=args[i+1];
 }
 if(!values['--dir'])throw new Error('Use init|serve --dir /private/packproof-rnd (outside the repository).');
 if(command==='init'){
  if(Object.keys(values).length!==1)throw new Error('Initialization accepts only --dir.');
  const directory=initializeRuntime(values['--dir']);
  console.log(`Initialized private research material at ${directory}. All optional processing remains disabled. The public trust file is local test trust, not independent certification.`);
 }else if(command==='serve'){
  const spec=prepareRuntime({directory:values['--dir'],port:values['--port']??3000,features:(values['--features']??'').split(',').filter(Boolean)});
  if(!existsSync(spec.args[0]))throw new Error('Build the backend first: npm --prefix backend run build');
  const child=spawn(spec.program,spec.args,spec.options);
  process.on('SIGINT',()=>child.kill('SIGINT'));process.on('SIGTERM',()=>child.kill('SIGTERM'));
  child.on('error',error=>{console.error(error.message);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
 }else throw new Error('Use init or serve. No deployment operation exists.');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}
}
