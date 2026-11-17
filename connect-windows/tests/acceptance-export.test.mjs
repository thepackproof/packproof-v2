import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishExport, checkReceipt } from '../scripts/publish-acceptance-export.mjs';

test('publishes distinct completed fixtures and reconciles only an exact receipt and Proof', async t=>{
  const parent=await mkdtemp(join(tmpdir(),'connect-export-test-'));
  t.after(()=>rm(parent,{recursive:true,force:true}));
  const {file,sha256,expected}=await publishExport(parent,'test-run','first');
  const next=await publishExport(parent,'test-run','ui-closed');
  assert.notEqual(next.sha256,sha256);
  await assert.rejects(publishExport(parent,'test-run','ui-closed'),{code:'EEXIST'});
  await assert.rejects(publishExport(parent,'../outside','first'));
  const receipt={id:'receipt-a',state:'succeeded',original:{sha256},rows:[{rowNumber:2,status:'imported',proofId:'proof-a',payloadSha256:'row-a',normalized:expected}],recordIds:['proof-a'],counts:{imported:1,duplicate:0,valid:0,invalid:0,ambiguous:0,failed:0}};
  const data={originalSha256:sha256,importId:'receipt-a',rowNumber:2,payloadSha256:'row-a',sourceReportedAt:expected.shippedAt};
  const proof={proofId:'proof-a',transaction:{itemTitle:expected.itemTitle,quantity:expected.quantity},events:[{eventType:'SERVICE_CSV_SHIPMENT_IMPORTED',data}]};
  const receiptPath=join(parent,'receipt.json'),proofPath=join(parent,'proof.json');
  await writeFile(receiptPath,JSON.stringify(receipt));await writeFile(proofPath,JSON.stringify({proof}));
  assert.equal((await checkReceipt(file,receiptPath,proofPath)).receiptId,receipt.id);
  await assert.rejects(checkReceipt(next.file,receiptPath,proofPath));
  proof.events[0].data.importId='another-receipt';
  await writeFile(proofPath,JSON.stringify({proof}));
  await assert.rejects(checkReceipt(file,receiptPath,proofPath));
  assert.match(await readFile(file,'utf8'),/QA-test-run-first/);
});
