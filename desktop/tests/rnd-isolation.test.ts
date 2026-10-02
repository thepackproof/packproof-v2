import {describe,it,expect,vi} from 'vitest';
import {loadConfig,validateConfig,type DesktopConfig} from '../src/main/config';
import {AuthService,type ProtectedSessionStore} from '../src/main/auth';
import {DesktopApi} from '../src/main/api';
import {schemas,parseDeepLink} from '../src/main/security';

const profile={userId:'local_user',username:'research',displayName:'Research',status:'ACTIVE',createdAt:'2026-10-02T00:00:00Z',updatedAt:'2026-10-02T00:00:00Z'};
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
function store(){let value:string|null=null;const adapter:ProtectedSessionStore={read:async()=>value,write:async v=>{value=v;},clear:async()=>{value=null;}};return {adapter,get:()=>value,set:(v:string)=>{value=v;}};}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
const research=()=>loadConfig({PACKPROOF_RESEARCH_BUILD:'1'});

describe('experimental desktop isolation',()=>{
 it('accepts loopback-only development with remote identity, update and telemetry disabled',()=>{
  expect(research()).toMatchObject({research:true,channel:'development',apiBaseUrl:'http://127.0.0.1:3000',webBaseUrl:'http://127.0.0.1:5173',cognito:{clientId:'',userPoolId:''}});
  for(const origin of ['http://localhost:3000','http://127.0.0.1:3000','http://[::1]:3000'])expect(validateConfig({...research(),apiBaseUrl:origin}).research).toBe(true);
  for(const patch of [
   {apiBaseUrl:'https://api.thepackproof.com'},{webBaseUrl:'https://thepackproof.com'},
   {apiBaseUrl:'http://localhost.evil.test'},{apiBaseUrl:'https://user:password@localhost:3000'},
   {apiBaseUrl:'https://localhost:3000?q=elsewhere'},{apiBaseUrl:'https://localhost:3000/#fragment'},
   {updateUrl:'https://updates.thepackproof.com'},{sentryDsn:'https://key@sentry.test/1'},
   {channel:'production'},{channel:'staging'},
   {cognito:{...research().cognito,clientId:'publicProductionClient'}},
   {cognito:{...research().cognito,userPoolId:'us-east-1_production'}},
  ])expect(()=>validateConfig({...research(),...patch} as DesktopConfig)).toThrow();
  expect(()=>loadConfig({PACKPROOF_RESEARCH_BUILD:'1',SENTRY_DSN:'https://public@sentry.test/1'})).toThrow();
 });
 it('uses only local development login and never transmits the password or contacts Cognito',async()=>{
  const storage=store(),fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(json({token:'local-token'})).mockResolvedValueOnce(json(profile));
  const auth=new AuthService({config:research(),store:storage.adapter,fetch:fetcher});
  const session=await auth.signIn({email:' Local@Example.test ',password:'must-never-leave-renderer'});
  expect(session.userId).toBe('local_user');
  expect(fetcher.mock.calls.map(call=>call[0])).toEqual(['http://127.0.0.1:3000/auth/dev/login','http://127.0.0.1:3000/me']);
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({subject:'local@example.test'});
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain('must-never-leave-renderer');
  expect(fetcher.mock.calls.every(call=>call[1]?.redirect==='error')).toBe(true);
  expect(JSON.stringify(session)).not.toContain('local-token');
  await expect(auth.signUp({email:'local@example.test',password:'x'})).rejects.toMatchObject({code:'AUTH_NOT_CONFIGURED'});
  expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('rejects inherited ordinary-development sessions even on the exact same API/channel',async()=>{
  const storage=store(),fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(json({token:'local-token'})).mockResolvedValueOnce(json(profile));
  const auth=new AuthService({config:research(),store:storage.adapter,fetch:fetcher});
  await auth.signIn({email:'local@example.test',password:'unused'});
  const raw=storage.get()!;
  const ordinary=new AuthService({config:{...research(),research:false},store:storage.adapter,fetch:fetcher});
  expect(await ordinary.restore()).toBeNull();expect(storage.get()).toBeNull();
  const legacy=JSON.parse(raw);legacy.scope='development|http://127.0.0.1:3000|';storage.set(JSON.stringify(legacy));
  const nextResearch=new AuthService({config:research(),store:storage.adapter,fetch:fetcher});
  expect(await nextResearch.restore()).toBeNull();expect(storage.get()).toBeNull();
 });
 it('fences a local login that completes after logout',async()=>{
  const pending=deferred<Response>(),began=deferred<void>(),storage=store();
  const fetcher=vi.fn<typeof fetch>().mockImplementationOnce(async()=>{began.resolve();return pending.promise;});
  const auth=new AuthService({config:research(),store:storage.adapter,fetch:fetcher});
  const result=auth.signIn({email:'local@example.test',password:'unused'});
  const rejected=expect(result).rejects.toMatchObject({code:'SESSION_CHANGED'});
  await began.promise;await auth.signOut();pending.resolve(json({token:'too-late'}));await rejected;
  expect(auth.getSession()).toBeNull();expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('disables every research API in ordinary builds and fences artifact requests across accounts',async()=>{
  const fetcher=vi.fn<typeof fetch>();const ordinary=new DesktopApi({config:{...research(),research:false},getAccountId:()=> 'user_a',getToken:async()=> 'token',fetch:fetcher});
  for(const invoke of [()=>ordinary.rndCapabilities(),()=>ordinary.rndList('proof_a'),()=>ordinary.rndWrite('proof_a','exports',{},'key12345'),()=>ordinary.rndArtifact('proof_a','analysis_a',0),()=>ordinary.rndReview('proof_a','analysis_a',{approved:true,artifactSha256:'a'.repeat(64),recipeSha256:'b'.repeat(64)},'key12345')])expect(invoke).toThrow('unavailable');
  expect(fetcher).not.toHaveBeenCalled();
  let account='user_a';const token=deferred<string>();const api=new DesktopApi({config:research(),getAccountId:()=>account,getToken:()=>token.promise,fetch:fetcher});
  const pending=api.rndArtifact('proof_a','analysis_a',0);account='user_b';token.resolve('token-b');
  await expect(pending).rejects.toMatchObject({code:'SESSION_CHANGED'});expect(fetcher).not.toHaveBeenCalled();
 });
 it('bounds research IPC and binds deep links to the research scheme',()=>{
  expect(parseDeepLink('packproof-research://proof/proof_a','packproof-research')).toBe('/proof/proof_a');
  expect(parseDeepLink('packproof://proof/proof_a','packproof-research')).toBeNull();
  expect(schemas.rndArtifact.safeParse(['proof_a','analysis_a',31]).success).toBe(true);
  for(const input of [['../../proof','analysis_a',0],['proof_a','analysis_a',32],['proof_a','analysis_a',-1],['proof_a','analysis_a',0,'override']])expect(schemas.rndArtifact.safeParse(input).success).toBe(false);
  const review={approved:true,artifactSha256:'a'.repeat(64),recipeSha256:'b'.repeat(64)};
  expect(schemas.rndReview.safeParse(['proof_a','analysis_a',review,'operation1']).success).toBe(true);
  expect(schemas.rndReview.safeParse(['proof_a','analysis_a',{...review,approved:false},'operation1']).success).toBe(false);
  expect(schemas.rndDerivative.safeParse(['proof_a',{evidenceIds:['one','two'],parameters:{}},'operation1']).success).toBe(false);
 });
});
