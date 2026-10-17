import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { creationEntryRoute, resolveBackRoute, type AppRoute } from '../src/app/navigation.ts';
import { createProofRequestGate, SupersededProofRequest } from '../src/experience/proof-request.ts';

// Exercise the actual provider callbacks with navigation/storage ports. Camera hardware is separately gated.
const source=ts.createSourceFile('provider.tsx',readFileSync(new URL('../src/app/PackProofProvider.tsx',import.meta.url),'utf8'),ts.ScriptTarget.ES2022,true,ts.ScriptKind.TSX);
function callback(name:string,ports:Record<string,unknown>) {
 let expression='';
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(source)===name&&node.initializer&&ts.isCallExpression(node.initializer))expression=node.initializer.arguments[0].getText(source);ts.forEachChild(node,visit);};visit(source);
 assert.ok(expression);
 return new Function(...Object.keys(ports),ts.transpileModule(`return (${expression});`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(...Object.values(ports));
}
function navigation(initial:AppRoute) {
 const routeRef={current:initial}, accountReturn={current:{name:'home'} as AppRoute}, captureReturn={current:null as null|{route:AppRoute;proofId:string|null}}, captureNavigationLock={current:false}, workspaceOrigin={current:'activity'}, sessionRef={current:{proofId:'selected-proof',userId:'owner',apiBaseUrl:'https://api'}};
 const notices:string[]=[];
 const ports={routeRef,accountReturn,captureReturn,captureNavigationLock,workspaceOrigin,sessionRef,creationEntryRoute,resolveBackRoute,proofRequests:{current:createProofRequestGate()},
  ANDROID_TASK_FIRST_REBUILD:true,MOBILE_TASK_UX_ENABLED:true,FIRST_PROOF_EXPERIENCE_ENABLED:false,
  startMobileCaptureEntry:()=>{},setError:(s:string|null)=>{if(s)notices.push(s);},setScanPhase:()=>{},setScanResult:()=>{},setScanInput:()=>{},setTechnicalOpen:()=>{},setConfirmFinalize:()=>{},setBatchPacking:()=>{},activityFilterMemory:{current:'all'},
  saveProofsCache:async()=>{},cacheRef:{current:{}},proofsScrollOffset:{current:0},taskIntent:()=>null,taskIntentKey:()=>'',AsyncStorage:{removeItem:async()=>{}},setRoute:(r:AppRoute)=>{routeRef.current=r;}};
 const go=callback('go',ports);const back=callback('goBack',{...ports,go});return {...ports,go,back,notices};
}
test('camera Back returns to saved item information on the same Proof, then camera again',()=>{
 const n=navigation({name:'manual'});n.go('capture');n.back();
 assert.deepEqual(n.routeRef.current,{name:'editPurchase',returnToCapture:true});
 assert.equal(n.sessionRef.current.proofId,'selected-proof');n.back();assert.equal(n.routeRef.current.name,'capture');n.back();assert.equal(n.routeRef.current.name,'editPurchase');
});
test('Activity profile integration Back returns to Activity; nested Settings returns to Settings',()=>{
 const n=navigation({name:'activity',activityFilter:'notifications'});n.go('account',{accountSection:'channels'});n.back();
 assert.equal(n.routeRef.current.name,'activity');assert.equal(n.routeRef.current.activityFilter,'notifications');
 n.go('account');n.go('account',{accountSection:'channels'});n.back();assert.equal(n.routeRef.current.name,'account');assert.equal(n.routeRef.current.accountSection,undefined);
});
test('Home, Back and another route cannot abandon an active capture',()=>{
 const n=navigation({name:'capture'});n.captureNavigationLock.current=true;n.go('home');n.back();n.go('account',{accountSection:'channels'});
 assert.equal(n.routeRef.current.name,'capture');assert.equal(n.sessionRef.current.proofId,'selected-proof');assert.equal(n.notices.length,3);
});
test('a camera return context cannot be reused for a different Proof',()=>{
 const n=navigation({name:'manual'});n.go('capture');n.sessionRef.current.proofId='another-proof';n.back();assert.equal(n.routeRef.current.name,'proof');
});
test('returning to a workspace cancels a pending record response without cancelling capture guards',()=>{
 const n=navigation({name:'proof'});const pending=n.proofRequests.current.begin();n.go('home');
 assert.throws(pending,SupersededProofRequest);assert.equal(n.routeRef.current.name,'home');
});

test('Evidence tools preserve the requested destination and exact selected Proof',()=>{
 for(const signatureTool of ['ask','compare','case','history']) {
  const n=navigation({name:'proof'});n.go('signature',{signatureTool});
  assert.equal(n.routeRef.current.signatureTool,signatureTool);
  assert.equal(n.sessionRef.current.proofId,'selected-proof');n.back();assert.equal(n.routeRef.current.name,'proof');
 }
});
