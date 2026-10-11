import {test} from 'node:test';
import assert from 'node:assert/strict';
import {manualDraftMatches,type ManualOperation} from '../src/experience/manual-operation.ts';
import {EMPTY_FORM} from '../src/copy/forms.ts';
test('an uncertain create retains the exact request and rejects a different draft until recovered',()=>{
  const form={...EMPTY_FORM,itemTitle:'Ceramic mug'};
  const operation:ManualOperation={fingerprint:'original',key:'operation_123',form,request:{itemTitle:'Ceramic mug',metadata:{intake:{source:'PROVIDED_TEXT'}}}};
  assert.equal(manualDraftMatches(null,form),true);
  assert.equal(manualDraftMatches(operation,{...form}),true);
  assert.equal(manualDraftMatches(operation,{...form,itemTitle:'Another item'}),false);
  assert.equal(manualDraftMatches(operation,{...form,trackingNumber:'changed'}),false);
  const reopened=JSON.parse(JSON.stringify(operation)) as ManualOperation;
  assert.equal(manualDraftMatches(reopened,{...reopened.form}),true);
  assert.deepEqual(reopened.request,operation.request);assert.equal(reopened.key,operation.key);
});
