import 'fake-indexeddb/auto';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {Website} from '../site/PublicSite';
import {saveSession} from '../auth/session';
import {canonicalProof, summary} from './fixtures';

let scrollPosition=0;
const response=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
beforeEach(()=>{
 sessionStorage.clear();localStorage.clear();scrollPosition=0;
 history.replaceState({},'', '/proofs?filter=all&q=shipment');
 saveSession({apiBaseUrl:'',authMode:'dev',userId:'user_seller',username:'seller',displayName:'Seller',token:'fixture',refreshToken:null,accessExpiresAt:null,subject:'fixture'});
 vi.spyOn(window,'scrollY','get').mockImplementation(()=>scrollPosition);
 vi.spyOn(window,'scrollTo').mockImplementation((first:number|ScrollToOptions)=>{
  const top=typeof first==='number'?first:first.top||0;
  scrollPosition=document.querySelector('.proof-row')?Math.max(0,top):0;
 });
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
  const index=this.dataset.contextAnchor?.match(/^proof-proof_history_(\d)$/)?.[1];
  const top=index!==undefined?390+Number(index)*150-scrollPosition:0;
  return {x:0,y:top,top,bottom:top+130,left:0,right:380,width:380,height:130,toJSON:()=>({})};
 });
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

it.each([0,4200])('restores list position, query, filter and selected row focus through the production Website wrapper after %ims list loading',async(delay)=>{
 let listRequests=0;
 const rows=Array.from({length:5},(_,index)=>({...summary,proofId:`proof_history_${index}`,transaction:{...summary.transaction,itemTitle:`Shipment ${index}`}}));
 const selected=rows[4];
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
  const url=new URL(String(input),location.origin);
  if(url.pathname==='/me/proofs'){
   listRequests++;
   if(listRequests>1&&delay)await new Promise(resolve=>setTimeout(resolve,delay));
   return response({proofs:rows,nextOffset:null});
  }
  if(url.pathname===`/proofs/${selected.proofId}`)return response({...canonicalProof,proofId:selected.proofId,transaction:{...canonicalProof.transaction,itemTitle:selected.transaction.itemTitle},evidence:[],attestations:[]});
  if(url.pathname.endsWith('/signature/'))return response({snapshot:{data:{anchors:[]}}});
  if(url.pathname.endsWith('/recovery'))return response({proofId:selected.proofId,evidence:[],declarations:[],finalization:{status:'NOT_FINALIZED',receipt:null}});
  if(url.pathname.endsWith('/capabilities'))return response({schemaVersion:1,capture:{protocolVersions:[1]},preservation:{receiptVersions:[1],durableReceiptsRequired:true}});
  return response({});
 }));
 const user=userEvent.setup();
 render(<Website/>);
 const row=await screen.findByRole('button',{name:/Shipment 4\. Recording needed/});
 scrollPosition=217;fireEvent.scroll(window);
 const originalTop=row.getBoundingClientRect().top;
 await user.click(row);
 await screen.findByRole('article',{name:'Proof record'});
 await waitFor(()=>expect(scrollPosition).toBe(0));
 await user.click(screen.getByRole('button',{name:'Back'}));
 const restored=await screen.findByRole('button',{name:/Shipment 4\. Recording needed/},{timeout:6500});
 await waitFor(()=>{
  expect(scrollPosition).toBe(217);
  expect(restored.getBoundingClientRect().top).toBe(originalTop);
  expect(restored).toHaveFocus();
 });
 expect(location.pathname+location.search).toBe('/proofs?filter=all&q=shipment');
 expect(screen.getByRole('button',{name:'All'})).toHaveAttribute('aria-pressed','true');
 expect(screen.getByRole('textbox',{name:'Search proofs'})).toHaveValue('shipment');
},12000);
