import {describe,it,expect} from 'vitest';
import {DesktopApi} from '../src/main/api';
import {loadConfig} from '../src/main/config';

describe('desktop Activity history',()=>{
 it('reads the fixed authenticated history endpoint',async()=>{
  const requests:Array<{url:string;auth:string|null}>=[];
  const api=new DesktopApi({config:loadConfig({PACKPROOF_API_BASE_URL:'https://api.example.test'}),getAccountId:()=> 'owner',getToken:async()=> 'test-token',fetch:async(url,options)=>{requests.push({url:String(url),auth:new Headers(options?.headers).get('Authorization')});return new Response(JSON.stringify({notifications:[{id:'notice',proofId:'proof',title:'Recording saved',createdAt:'2026-10-13T00:00:00Z'}]}));}});
  expect((await api.listActivity()).notifications[0].proofId).toBe('proof');
  expect(requests).toEqual([{url:'https://api.example.test/me/notifications',auth:'Bearer test-token'}]);
 });
 it('rejects a response if the account changes during loading',async()=>{
  let owner='owner';
  const api=new DesktopApi({config:loadConfig({PACKPROOF_API_BASE_URL:'https://api.example.test'}),getAccountId:()=>owner,getToken:async()=> 'test-token',fetch:async()=>{owner='another';return new Response(JSON.stringify({notifications:[]}));}});
  await expect(api.listActivity()).rejects.toMatchObject({code:'SESSION_CHANGED'});
 });
 it('retains a server error rather than returning an empty history',async()=>{
  const api=new DesktopApi({config:loadConfig({PACKPROOF_API_BASE_URL:'https://api.example.test'}),getAccountId:()=> 'owner',getToken:async()=> 'test-token',fetch:async()=>new Response('{}',{status:503})});
  await expect(api.listActivity()).rejects.toMatchObject({status:503});
 });
});
