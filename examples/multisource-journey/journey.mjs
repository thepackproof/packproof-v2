import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const sourceFolders = ['order', 'picking', 'packing', 'evidence', 'shipping', 'handoff', 'delivery', 'returns'];
const marker = 'packproof.sample-journey/v1';
const step = (name, role, ...assets) => ({name, role, assets});

export function sequence(variant = 'standard') {
  const origin = step('Create sales order', 'order', 'orders.json');
  const early = step('Unresolved package evidence', 'evidence', 'early_evidence.json');
  const correction = {...step('Correct ordered quantity', 'order', 'corrections.json'), target: 'orders.json'};
  const events = [
    origin, step('Warehouse picks', 'picking', 'picking.csv'), step('Pack split shipments', 'packing', 'packages.xml'),
    step('Packing photograph', 'evidence', 'packing_photo.jpg', 'packing_photo.json'),
    step('Labels and tracking bridges', 'shipping', 'label.zpl', 'labels.json'),
    step('Physical carrier handoff', 'handoff', 'handoff.json'), step('Delivery scans', 'delivery', 'delivery.jsonl'),
    step('Repeat delivery scans', 'delivery', 'delivery.jsonl'), step('Repeat original sales export', 'order', 'orders.json'),
    correction, early, step('Late package relationship', 'packing', 'late_bridge.json'),
  ];
  if (variant === 'reordered') return [early, ...events.filter(item => item !== early)];
  if (variant === 'consolidated') return [...events, step('Second order', 'order', 'second_order.json'), step('Shared shipment allocation', 'handoff', 'consolidated.json'), step('One item returned', 'returns', 'return.json')];
  if (variant === 'cancelled') return [...events, {...step('Cancel remaining unit', 'order', 'cancellation.json'), target:'orders.json'}];
  if (variant === 'burst') return [...events, ...Array.from({length:8}, (_, i) => step('Bounded replay ' + (i + 1), 'delivery', 'delivery.jsonl'))];
  if (variant !== 'standard') throw Error('Unknown scenario variant');
  return events;
}
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const digest = data => createHash('sha256').update(data).digest('hex');

export async function prepare(parent = tmpdir(), variant = 'standard') {
  sequence(variant);
  const root = await mkdtemp(join(resolve(parent), 'packproof-sample-'));
  await Promise.all([...sourceFolders, 'output', 'other-owner'].map(name => mkdir(join(root, name))));
  await writeFile(join(root, 'scenario.json'), JSON.stringify({schema:marker, variant, id:randomUUID(), next:0, observations:[]}, null, 2));
  return root;
}

async function atomicCopy(asset, target) {
  const bytes = await readFile(join(fixtures, asset));
  const temp = target + '.' + randomUUID() + '.tmp';
  await writeFile(temp, bytes, {flag:'wx'});
  try { await rename(temp, target); } finally { await rm(temp, {force:true}); }
  return {file:basename(target), bytes:bytes.length, sha256:digest(bytes)};
}

export async function emitNext(directory, eventUrl) {
  const root = resolve(directory);
  const statePath = join(root, 'scenario.json');
  const state = await readJson(statePath);
  assert.equal(state.schema, marker, 'A directory created by the sample runner is required');
  const lock = await open(join(root, 'runner.lock'), 'wx');
  try {
    const current = await readJson(statePath);
    const action = sequence(current.variant)[current.next];
    if (!action) return null;
    const emitted = [];
    for (const asset of action.assets) {
      if (eventUrl && action.role === 'order') {
        const target = new URL(eventUrl);
        if (!['http:','https:'].includes(target.protocol) || !['localhost','127.0.0.1','[::1]'].includes(target.hostname) || target.username || target.password)
          throw Error('Event target must be a loopback test adapter');
        const bytes = await readFile(join(fixtures, asset));
        const response = await fetch(target, {method:'POST', redirect:'error', signal:AbortSignal.timeout(10000),
          headers:{'content-type':'application/json','x-packproof-sample-operation':current.id,'idempotency-key':current.id + '/' + digest(bytes)}, body:bytes});
        if (!response.ok) throw Error('Sample adapter returned HTTP ' + response.status);
        emitted.push({file:asset, transport:'event', status:response.status, sha256:digest(bytes)});
      } else emitted.push(await atomicCopy(asset, join(root, action.role, action.target ?? asset)));
    }
    const observed = {step:current.next + 1, name:action.name, role:action.role, emitted, publishedAt:new Date().toISOString()};
    current.next++;
    current.observations.push(observed);
    const staging = statePath + '.tmp';
    await writeFile(staging, JSON.stringify(current, null, 2));
    await rename(staging, statePath);
    return observed;
  } finally { await lock.close(); await rm(join(root,'runner.lock')); }
}

export async function selfCheck() {
  const expected = await readJson(join(fixtures,'expected.json'));
  const origin = await readJson(join(fixtures,'orders.json'));
  const correction = await readJson(join(fixtures,'corrections.json'));
  assert.deepEqual(origin.lines.map(l => [l.lineId,l.sku,l.orderedQuantity]),expected.allocations.map(l=>[l.lineId,l.sku,l.shippedQuantity]));
  assert.equal(correction.lines.reduce((n,line)=>n+line.orderedQuantity,0),expected.afterCorrection.ordered);
  const media = await readJson(join(fixtures,'packing_photo.json'));
  assert.equal(media.artifactSha256,digest(await readFile(join(fixtures,'packing_photo.jpg'))));
  const labels = await readJson(join(fixtures,'labels.json'));
  assert.equal(labels[0].artifactSha256,digest(await readFile(join(fixtures,'label.zpl'))));
  for (const variant of ['standard','reordered','consolidated','cancelled','burst']) {
    const root=await prepare(tmpdir(),variant);
    try {
      const history=[];
      while (true) { const next=await emitNext(root); if (!next) break; history.push(next); }
      assert.equal(history.length,sequence(variant).length);
      for (const entry of history) for (const item of entry.emitted) assert.match(item.sha256,/^[0-9a-f]{64}$/);
      assert.deepEqual(await readdir(join(root,'other-owner')),[]);
      assert.deepEqual(await readdir(join(root,'output')),[]);
      assert.equal((await readJson(join(root,'order/orders.json'))).version,variant === 'cancelled' ? 3 : 2);
    } finally { await rm(root,{recursive:true}); }
  }
  return {scope:'fixture integrity and deterministic publication', variants:5};
}

async function main([action, location, extra]) {
  if (action === 'self-check') return selfCheck();
  if (action === 'prepare') return {workspace:await prepare(location || tmpdir(),extra || 'standard')};
  if (!location) throw Error('Supply the isolated sample directory returned by prepare');
  if (action === 'next') return await emitNext(location,process.env.PACKPROOF_SAMPLE_EVENT_URL) ?? {done:true};
  if (action === 'run') {
    let count=0;
    while (await emitNext(location,process.env.PACKPROOF_SAMPLE_EVENT_URL)) count++;
    return {published:count, evidence:join(resolve(location),'scenario.json')};
  }
  if (action === 'other-owner') {
    const state=await readJson(join(location,'scenario.json'));
    assert.equal(state.schema,marker);
    return atomicCopy('unrelated_order.json',join(location,'other-owner','orders.json'));
  }
  if (action === 'expect') return readJson(join(fixtures,'expected.json'));
  throw Error('Use prepare [parent] [variant], next DIR, run DIR, other-owner DIR, expect DIR, or self-check');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
