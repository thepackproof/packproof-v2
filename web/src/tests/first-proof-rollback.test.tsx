import 'fake-indexeddb/auto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {App} from '../App';
import {saveSession} from '../auth/session';
import {creationOperation,draftStorageKey,pendingCreationRequest,saveDraft} from '../first-experience/state';
import type {TransactionWriteInput} from '../api/types';

beforeEach(()=>{localStorage.clear();sessionStorage.clear();history.replaceState({},'','/new');});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

it('restores a pending draft and retries its exact operation after presentation rollback',async()=>{
 vi.stubEnv('VITE_PACKPROOF_FIRST_PROOF_EXPERIENCE','false');
 saveSession({apiBaseUrl:'',authMode:'dev',userId:'rollback-user',username:'rollback',displayName:'Rollback user',token:'fixture',refreshToken:null,accessExpiresAt:null,subject:'fixture'});
 const key=draftStorageKey('','rollback-user');
 const original:TransactionWriteInput={itemTitle:'Original submitted camera',externalReference:null,itemDescription:null,currency:'USD',quantity:1,transactionValue:null,shipping:{carrier:null,trackingNumber:null}};
 const identity=creationOperation(key,original);
 saveDraft(key,{title:'Unsent replacement title',reference:'',description:'',currency:'USD',quantity:'1',amount:'',carrier:'',tracking:'',intake:null});
 const submitted:unknown[]=[];let proofAttempts=0;
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=String(input);
  if(path.endsWith('/transactions')&&init?.method==='POST'){
   submitted.push(JSON.parse(String(init.body)));return json({transactionId:'txn_original'},201);
  }
  if(path.endsWith('/transactions/txn_original/proof')&&init?.method==='POST'){
   proofAttempts++;return json({error:{code:'SERVICE_UNAVAILABLE',message:'Temporary downstream failure'}},503);
  }
  return json({proofs:[],invitations:[],items:[],marketplaces:[],connections:[],sources:[],onboarding_completed:true,onboarding_enrolled:false,current_version:1});
 }));
 render(<App/>);
 expect(await screen.findByRole('textbox',{name:'Item name'})).toHaveValue('Unsent replacement title');
 expect(screen.getByRole('button',{name:/Continue to camera/})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'Recover submitted draft'}));
 await waitFor(()=>expect(proofAttempts).toBe(1));
 expect(submitted).toEqual([{...original,idempotencyKey:identity}]);
 expect(pendingCreationRequest(key)).toEqual(original);
 expect(creationOperation(key,original)).toBe(identity);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Recover submitted draft'})).toBeEnabled());
 fireEvent.click(screen.getByRole('button',{name:'Recover submitted draft'}));
 await waitFor(()=>expect(proofAttempts).toBe(2));
 expect(submitted).toEqual([{...original,idempotencyKey:identity},{...original,idempotencyKey:identity}]);
});
