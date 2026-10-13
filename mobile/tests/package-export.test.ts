import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exportEvidencePackage} from '../src/experience/package-export';

test('downloads only after authentication and current account checks, then removes temporary bytes',async()=>{
 const calls:string[]=[];
 await exportEvidencePackage({authenticate:async()=>{calls.push('auth');},assertCurrent:()=>{calls.push('scope');},available:async()=>true,download:async()=>{calls.push('download');return 200;},share:async()=>{calls.push('save');},remove:async()=>{calls.push('remove');}});
 assert.deepEqual(calls,['auth','scope','scope','download','scope','save','remove']);
});
test('a rejected package never opens the native save flow and still removes temporary bytes',async()=>{
 let shared=false,removed=false;
 await assert.rejects(()=>exportEvidencePackage({authenticate:async()=>{},assertCurrent:()=>{},available:async()=>true,download:async()=>403,share:async()=>{shared=true;},remove:async()=>{removed=true;}}),/could not be downloaded/);
 assert.equal(shared,false);assert.equal(removed,true);
});
test('an account change during download prevents opening the file',async()=>{
 let current=true,shared=false,removed=false;
 await assert.rejects(()=>exportEvidencePackage({authenticate:async()=>{},assertCurrent:()=>{if(!current)throw new Error('Account changed');},available:async()=>true,download:async()=>{current=false;return 200;},share:async()=>{shared=true;},remove:async()=>{removed=true;}}),/Account changed/);
 assert.equal(shared,false);assert.equal(removed,true);
});
test('failed native save cleans the cache and leaves retry available',async()=>{
 let removed=0;
 const io={authenticate:async()=>{},assertCurrent:()=>{},available:async()=>true,download:async()=>200,share:async()=>{throw new Error('Save failed');},remove:async()=>{removed++;}};
 await assert.rejects(()=>exportEvidencePackage(io),/Save failed/);
 await exportEvidencePackage({...io,share:async()=>{}});
 assert.equal(removed,2);
});
