import {describe,expect,it,vi} from 'vitest';
import type {Request,Response,NextFunction} from 'express';
import {httpBoundary} from '../src/http/boundary.js';

// Exercise the actual middleware without a listener, database, or test auth bypass.
function run(method:string,origin?:string){
 const headers:Record<string,string>={},end=vi.fn(),next=vi.fn();let status=200;
 const req={method,header:(name:string)=>name.toLowerCase()==='origin'?origin:undefined};
 const res={
  setHeader:(name:string,value:string)=>{headers[name.toLowerCase()]=value;},
  vary:(name:string)=>{headers.vary=name;},
  status:(value:number)=>{status=value;return res;},end,
 };
 httpBoundary(['https://portal.fixture.invalid'])(req as unknown as Request,res as unknown as Response,next as NextFunction);
 return {headers,end,next,status};
}
const values=(header:string)=>header.split(',').map(value=>value.trim().toLowerCase());

describe('records browser boundary',()=>{
 it('allows revision and explicit merchant selectors only for the configured origin',()=>{
  const result=run('OPTIONS','https://portal.fixture.invalid');
  expect(result.status).toBe(204);expect(result.end).toHaveBeenCalledOnce();expect(result.next).not.toHaveBeenCalled();
  expect(result.headers['access-control-allow-origin']).toBe('https://portal.fixture.invalid');
  expect(values(result.headers['access-control-allow-headers'])).toEqual(expect.arrayContaining([
   'authorization','idempotency-key','if-match','if-none-match','packproof-merchant-id','packproof-delegation-id','range',
  ]));
  expect(result.headers['access-control-allow-origin']).not.toBe('*');
  expect(result.headers['access-control-allow-credentials']).toBeUndefined();
 });
 it('exposes revisions, retry and evidence download metadata on an allowed actual response',()=>{
  const result=run('GET','https://portal.fixture.invalid');
  expect(result.next).toHaveBeenCalledOnce();expect(result.end).not.toHaveBeenCalled();
  expect(values(result.headers['access-control-expose-headers'])).toEqual(expect.arrayContaining([
   'etag','idempotency-replayed','location','retry-after','content-range','accept-ranges',
   'content-disposition','x-artifact-sha256','packproof-package-scope','x-request-id',
  ]));
  expect(result.headers['cache-control']).toBe('private, no-store');
  expect(result.headers['x-content-type-options']).toBe('nosniff');
  expect(result.headers['referrer-policy']).toBe('no-referrer');
 });
 it('does not reflect unknown, lookalike, null or absent origins',()=>{
  for(const origin of ['https://attacker.invalid','https://portal.fixture.invalid.attacker.invalid','null',undefined]){
   const result=run('OPTIONS',origin);
   expect(result.status).toBe(204);
   for(const name of ['access-control-allow-origin','access-control-allow-headers','access-control-expose-headers'])expect(result.headers[name]).toBeUndefined();
   expect(result.headers.vary).toBe('Origin');
   expect(result.headers['cache-control']).toBe('private, no-store');
  }
 });
});
