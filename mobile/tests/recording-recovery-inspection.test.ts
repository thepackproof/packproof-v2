import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { recoveryPresentation } from '../src/experience/recovery-presentation';
import { activityGroup, activityRecordingUsable } from '../src/experience/activity-model';

// Evaluate the actual component bodies with native UI ports. This verifies reachability
// and original identity, not pixels, codec playback, or hardware persistence.
type Element={type:unknown;props:Record<string,any>};
const React={createElement:(type:unknown,props:Record<string,any>|null,...children:unknown[]):Element=>({type,props:{...props,children}})};
const useTheme=()=>({colors:{textPrimary:'#111',textSecondary:'#333'}});
function component(file:string,name:string,ports:Record<string,unknown>) {
 const source=ts.createSourceFile(file,readFileSync(new URL(file,import.meta.url),'utf8'),ts.ScriptTarget.ES2022,true,ts.ScriptKind.TSX);
 const body=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name)?.getText(source).replace(/^export /,'');
 assert.ok(body);const js=ts.transpileModule(`return (${body});`,{fileName:'component.tsx',compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}}).outputText;
 return new Function('React',...Object.keys(ports),js)(React,...Object.values(ports));
}
function elements(value:any):Element[]{if(Array.isArray(value))return value.flatMap(elements);if(value&&typeof value==='object'&&'type'in value)return [value,...elements(value.props.children)];return [];}
const original={uri:'file:///retained-exact.mp4',captureProofId:'proof-a',captureUserId:'owner',byteSize:1000,durationMs:1200,localFileAvailable:true,interrupted:true,recovery:{phase:'RECORDING',submitRequested:false,operationId:'op-a'}};

test('the focused Activity recovery destination exposes inspection for the selected interrupted take',()=>{
 const Inspection='RetainedInspection',calls:string[]=[];
 const Row=component('../src/screens/ActivityScreen.tsx','AndroidRecordingRow',{
  usePackProof:()=>({proofCollection:[],uploadProgressByProof:{},offline:true,busy:false,go:()=>calls.push('navigate')}),useTheme,useState:()=>[false,()=>{}],
  recoveryPresentation,activityGroup,activityRecordingUsable,captureCompletionActive:()=>false,mayCleanUpCapture:()=>false,
  styles:{group:{}},taskFirstTypography:{},View:'View',Text:'Text',StatusBadge:'Badge',ProgressState:'Progress',Button:'Button',RetainedRecordingInspection:Inspection,
 });
 const nodes=elements(Row({capture:original,focused:true}));
 assert.equal(nodes.find(n=>n.type===Inspection)?.props.capture,original);
 assert.ok(nodes.some(n=>n.type==='Button'&&n.props.label==='Review recovery options'));
 assert.deepEqual(calls,[]);
});

test('inspection opens the exact surviving original without a submit or capture command',()=>{
 let visible=false;
 const Inspect=component('../src/ui/RetainedRecordingInspection.tsx','RetainedRecordingInspection',{
  useState:()=>[visible,(next:boolean)=>{visible=next;}],useTheme,typography:{secondary:{}},View:'View',Text:'Text',Button:'Button',VideoReview:'Video',
 });
 const initial=elements(Inspect({capture:original}));assert.equal(initial.some(n=>n.type==='Video'),false);
 initial.find(n=>n.type==='Button')!.props.onPress();
 const opened=elements(Inspect({capture:original})),video=opened.find(n=>n.type==='Video');
 assert.equal(video?.props.uri,original.uri);assert.equal(video?.props.inspection,true);
 assert.equal(opened.filter(n=>n.type==='Button').length,1);
 assert.equal(original.recovery.phase,'RECORDING');assert.equal(original.recovery.submitRequested,false);
});

test('missing media never offers a surviving-video playback control',()=>{
 const Inspect=component('../src/ui/RetainedRecordingInspection.tsx','RetainedRecordingInspection',{
  useState:()=>[false,()=>{}],useTheme,typography:{secondary:{}},View:'View',Text:'Text',Button:'Button',VideoReview:'Video',
 });
 assert.equal(Inspect({capture:{...original,localFileAvailable:false}}),null);
});
