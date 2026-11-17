import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Compare an independently obtained online receipt to the currently published local revision.
export async function verifyOutput(output, receipt) {
  assert.ok(typeof receipt.proofId === 'string' && receipt.proofId.length);
  assert.ok(Number.isSafeInteger(receipt.revision) && receipt.revision > 0);
  const base = await realpath(output);
  const suffix = createHash('sha256').update(receipt.proofId).digest('hex').slice(0,24);
  const matches=(await readdir(base,{withFileTypes:true})).filter(item=>item.isDirectory() && item.name.endsWith(suffix));
  assert.equal(matches.length,1,'Expected one output directory for the online proof');
  const proof=await realpath(join(base,matches[0].name));
  const html=await readFile(join(proof,'current.html'),'utf8');
  const links=[...new Set([...html.matchAll(/revision-(\d+)\/summary\.html/g)].map(match=>match[0]))];
  assert.equal(links.length,1,'Current summary must identify one complete revision');
  const rev=dirname(links[0]);
  assert.equal(Number(rev.slice('revision-'.length)),receipt.revision,'Published output is behind or ahead of the supplied receipt');
  const revisionDir=join(proof,rev);
  const summary=await stat(join(proof,links[0]));
  assert.ok(summary.isFile() && summary.size>0);
  const manifest=JSON.parse(await readFile(join(revisionDir,'manifest.json'),'utf8'));
  assert.equal(manifest.schema,'packproof.order-output/v1');
  assert.equal(manifest.proofId,receipt.proofId);
  assert.equal(manifest.revision,receipt.revision);
  assert.equal(manifest.orderReference,receipt.orderReference);
  assert.ok(manifest.files.some(f=>f.file==='record.json'), 'Expected record.json in the hash inventory');
  for(const {file,sha256} of manifest.files) {
    const path=await realpath(resolve(revisionDir,file));
    const local=relative(proof,path);
    assert.ok(local && !isAbsolute(local) && local!=='..' && !local.startsWith('..'+sep),'Manifest contains an external file');
    assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'),sha256,file);
  }
  const local=JSON.parse(await readFile(join(revisionDir,'record.json'),'utf8'));
  assert.equal(local.proofId,receipt.proofId);
  assert.equal(local.revision,receipt.revision);
  if(receipt.lines) assert.deepEqual(local.lines,receipt.lines);
  return {proofId:local.proofId,revision:local.revision,filesVerified:manifest.files.length,directory:basename(proof),verifiedAt:new Date().toISOString()};
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [output,receipt]=process.argv.slice(2);
  if(!output || !receipt) throw Error('Usage: node verify-output.mjs OUTPUT_FOLDER ONLINE_DETAIL_JSON');
  verifyOutput(output,JSON.parse(await readFile(receipt,'utf8'))).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
