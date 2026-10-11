import {afterEach,expect,it} from 'vitest';
import request from 'supertest';
import {auth,createHarness,login,type TestHarness} from './helpers.js';
import {createTransaction,updateTransaction} from '../src/domain/transactions.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
let h:TestHarness;afterEach(async()=>{await h?.close();});
it('recovers an uncertain creation response with the same account-bound transaction and root Proof',async()=>{
 h=await createHarness();const seller=await login(h.app,'retry-create');
 const input={idempotencyKey:'manual-operation-001',itemTitle:'  Camera lens  ',quantity:1,shipping:{carrier:'UPS'},metadata:{origin:'manual'}};
 const first=await request(h.app).post('/transactions').set(auth(seller)).send(input);expect(first.status).toBe(201);
 const root=await createOrGetProof(h.db,h.clock,seller,first.body.transactionId);
 const retried=await request(h.app).post('/transactions').set(auth(seller)).send({...input,itemTitle:'Camera lens',metadata:{origin:'manual'}});
 expect(retried.status).toBe(201);expect(retried.body.transactionId).toBe(first.body.transactionId);expect(retried.body.externalReference).toBeNull();
 expect((await createOrGetProof(h.db,h.clock,seller,retried.body.transactionId)).proofId).toBe(root.proofId);
 const repeated=await Promise.all([createTransaction(h.db,h.clock,seller,input),createTransaction(h.db,h.clock,seller,input)]);
 expect(repeated.map(result=>result.transactionId)).toEqual([first.body.transactionId,first.body.transactionId]);
 expect((await h.db.query('SELECT id FROM transactions WHERE created_by=$1',[seller])).rows).toHaveLength(1);
 await updateTransaction(h.db,h.clock,seller,first.body.transactionId,{itemTitle:'Corrected lens'});
 expect((await createTransaction(h.db,h.clock,seller,input)).itemTitle).toBe('Corrected lens');
});
it('rejects changed fields, shipping and metadata for the same operation without creating another record',async()=>{
 h=await createHarness();const seller=await login(h.app,'changed-create');
 const input={idempotencyKey:'manual-operation-002',itemTitle:'Item',shipping:{carrier:'UPS'},metadata:{origin:'manual'}};
 await createTransaction(h.db,h.clock,seller,input);
 for(const change of [{itemTitle:'Other item'},{shipping:{carrier:'USPS'}},{quantity:2},{metadata:{origin:'changed'}}])
  await expect(createTransaction(h.db,h.clock,seller,{...input,...change})).rejects.toMatchObject({code:'TRANSACTION_CREATE_CONFLICT',httpStatus:409});
 expect((await h.db.query('SELECT id FROM transactions WHERE created_by=$1',[seller])).rows).toHaveLength(1);
});
it('isolates identical operation keys by authenticated account and rejects forged server metadata',async()=>{
 h=await createHarness();const first=await login(h.app,'create-account-a'),second=await login(h.app,'create-account-b');
 const input={idempotencyKey:'same-operation-key',itemTitle:'Item'};
 const a=await createTransaction(h.db,h.clock,first,input),b=await createTransaction(h.db,h.clock,second,input);expect(a.transactionId).not.toBe(b.transactionId);
 for(const data of [{...input,metadata:{_packproofCreate:{version:1,requestSha256:'forged'}}},{metadata:{_packproofCreate:{}}},{...input,idempotencyKey:'bad key'},{...input,metadata:[]}])
  expect((await request(h.app).post('/transactions').set(auth(first)).send(data)).status).toBe(400);
});
it('retains legacy unkeyed creation and external-reference behavior',async()=>{
 h=await createHarness();const user=await login(h.app,'legacy-create');
 const first=await createTransaction(h.db,h.clock,user,{itemTitle:'One'}),second=await createTransaction(h.db,h.clock,user,{itemTitle:'One'});expect(first.transactionId).not.toBe(second.transactionId);
 const reference=await createTransaction(h.db,h.clock,user,{externalReference:'existing-reference',itemTitle:'Item'});
 expect((await createTransaction(h.db,h.clock,user,{externalReference:'existing-reference'})).transactionId).toBe(reference.transactionId);
 await expect(createTransaction(h.db,h.clock,user,{externalReference:'existing-reference',idempotencyKey:'new-operation-key'})).rejects.toMatchObject({code:'TRANSACTION_CREATE_CONFLICT'});
});
