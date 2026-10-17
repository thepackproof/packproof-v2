import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {handledActionSucceeded} from '../src/experience/proof-entry';
import {selectRecoveryWorkspace} from '../src/experience/recovery-workspace';
import {actionIdentity} from '../src/experience/task-home';
import {createProofRequestGate} from '../src/experience/proof-request';

// Exercise actual command owners with network/storage ports. This is not device evidence.
function command(file:string,name:string,ports:Record<string,unknown>) {
 const source=ts.createSourceFile(file,readFileSync(new URL(file,import.meta.url),'utf8'),ts.ScriptTarget.ES2022,true,ts.ScriptKind.TSX);
 let expression='';
 const visit=(n:ts.Node)=>{if(ts.isPropertyAssignment(n)&&n.name.getText(source)===name)expression=n.initializer.getText(source);
  if(ts.isFunctionDeclaration(n)&&n.name?.text===name)expression=n.getText(source);ts.forEachChild(n,visit);};visit(source);
 assert.ok(expression);return new Function(...Object.keys(ports),ts.transpileModule(`return (${expression});`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(...Object.values(ports));
}
const draft=(id='draft-a',phase='SUBMITTING')=>({schema:1,id,actionKey:'action-'+id,updatedAt:'2026-10-17',apiBaseUrl:'https://api.example',userId:'owner',proofId:'proof-a',actionType:'CAPTURE_ASSET',recipe:'CARD_STANDARD_V1',assetId:id,transferId:null,phase,slots:[],retainedUris:[]});
function provider(drafts:any[]=[draft()],retry?:(d:any)=>Promise<void>) {
 const calls:string[]=[],errors:string[]=[];
 const sessionRef={current:{userId:'owner',apiBaseUrl:'https://api.example'}};
 const ports={proofRequests:{current:createProofRequestGate()},captureNavigationLock:{current:false},setError:(s:string)=>errors.push(s),pendingInvites:[],proofCollection:[],rememberTaskInteraction:()=>{},startMobileCaptureEntry:()=>{},offline:false,ANDROID_TASK_FIRST_REBUILD:true,
  photoDrafts:drafts,sessionRef,handledActionSucceeded,run:async(fn:()=>Promise<unknown>)=>{try{return await fn();}catch(e){errors.push((e as Error).message);}},
  client:{assertCaptureAccount:(id:string,api:string)=>{if(sessionRef.current.userId!==id||sessionRef.current.apiBaseUrl!==api)throw Error('ACCOUNT_CHANGED');}},
  processPhotoSubmission:async(d:any,manual:boolean)=>{calls.push('retry:'+d.id);assert.equal(manual,true);await retry?.(d);},openProof:async(id:string)=>{calls.push('snapshot:'+id);}};
 return {open:command('../src/app/PackProofProvider.tsx','openProofAction',ports),calls,errors,sessionRef,gate:ports.proofRequests.current};
}
test('checking photo submission invokes recovery for the exact recommended draft before loading its Proof',async()=>{
 const h=provider([draft('other-item'),draft()]);assert.equal(await h.open('proof-a','draft-a'),true);
 assert.deepEqual(h.calls,['retry:draft-a','snapshot:proof-a']);
});
test('ordinary entry also reconciles an already-authorized photo submission',async()=>{
 const h=provider([draft('unsubmitted','LOCAL_ONLY'),draft()]);await h.open('proof-a');
 assert.deepEqual(h.calls,['retry:draft-a','snapshot:proof-a']);
});
test('opening accepted local photos never authorizes submission',async()=>{
 const h=provider([draft('draft-a','LOCAL_ONLY')]);await h.open('proof-a','draft-a');assert.deepEqual(h.calls,['snapshot:proof-a']);
});
test('a stale task never falls back to another item, Proof or account',async()=>{
 for(const saved of [draft('different-item'),{...draft(),proofId:'proof-b'},{...draft(),userId:'other'},{...draft(),apiBaseUrl:'https://other.example'},{...draft(),phase:'COMPLETE'}]){
  const h=provider([saved]);assert.equal(await h.open('proof-a','draft-a'),false);assert.deepEqual(h.calls,[]);assert.match(h.errors[0],/task changed/);
 }
});
test('retry errors retain recovery and never announce a successful navigation',async()=>{
 const h=provider([draft()],async()=>{throw Error('No connection; original kept');});
 assert.equal(await h.open('proof-a','draft-a'),false);assert.deepEqual(h.calls,['retry:draft-a']);assert.match(h.errors[0],/original kept/);
});
test('an account change during reconciliation cannot open the old Proof',async()=>{
 const h=provider([draft()],async()=>{h.sessionRef.current.userId='other';});
 assert.equal(await h.open('proof-a','draft-a'),false);assert.deepEqual(h.calls,['retry:draft-a']);assert.deepEqual(h.errors,['ACCOUNT_CHANGED']);
});
test('leaving the requested Proof during a slow check prevents its late navigation',async()=>{
 const h=provider([draft()],async()=>{h.gate.begin();});
 assert.equal(await h.open('proof-a','draft-a'),false);assert.deepEqual(h.calls,['retry:draft-a']);
});
function home(app:Record<string,unknown>) {
 return command('../src/experience/use-task-home.ts','runAction',{app,actionBusy:{current:false},recordMobileUxEvent:()=>{},setInteracting:()=>{}});
}
test('Home passes the recommended draft identity to its native command',async()=>{
 const calls:unknown[]=[];const run=home({rememberTaskInteraction:()=>{},openProofAction:async(...args:unknown[])=>{calls.push(args);}});
 await run({kind:'continue_proof',targetId:'proof-a',photoDraftId:'draft-a'});assert.deepEqual(calls,[['proof-a','draft-a']]);
});
test('Home Refresh Proof executes the exact snapshot owner, not a workspace-list refresh',async()=>{
 const calls:string[]=[];const run=home({rememberTaskInteraction:()=>{},run:(f:()=>Promise<void>)=>f(),openProof:async(id:string)=>{calls.push(id);}});
 await run({kind:'reconcile',targetId:'proof-b'});assert.deepEqual(calls,['proof-b']);
});
test('repeat recommendation taps cannot overlap while its command is pending',async()=>{
 let release!:()=>void,calls=0;const waiting=new Promise<void>(r=>{release=r;});
 const run=home({rememberTaskInteraction:()=>{},openProofAction:async()=>{calls++;await waiting;}});
 const first=run({kind:'continue_proof',targetId:'proof-a',photoDraftId:'draft-a'});
 await run({kind:'continue_proof',targetId:'proof-a',photoDraftId:'draft-a'});assert.equal(calls,1);release();await first;
});
test('workspace recommendations carry exact draft identity and cannot pin a replaced item task',()=>{
 const input:any={proofs:[{proofId:'proof-a',transactionId:'txn',role:'SELLER',status:'READY_FOR_EVIDENCE',transaction:{itemTitle:'Item'},createdAt:'2026-10-17',updatedAt:'2026-10-17'}],photoDrafts:[draft()],invitations:[],captures:[],orders:[],progress:{},userId:'owner',apiBaseUrl:'https://api.example',online:true,reconciled:true};
 const first=selectRecoveryWorkspace(input).model.recommendation;assert.equal(first.photoDraftId,'draft-a');
 input.photoDrafts=[draft('draft-b')];const next=selectRecoveryWorkspace(input).model.recommendation;assert.notEqual(actionIdentity(first),actionIdentity(next));
});
