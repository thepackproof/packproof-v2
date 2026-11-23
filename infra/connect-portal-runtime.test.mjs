import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyApiTarget, target } from './connect-portal-release.mjs';
import { verifyRuntimeInputs } from './connect-portal-runtime.mjs';

const image = '784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api@sha256:' + 'a'.repeat(64);

test('a portal release rejects changes to any deployed runtime input, image recipe or build ignore rules', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'portal-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'core.autocrlf=false', '-c', 'user.name=tests',
    '-c', 'user.email=tests@example.invalid', ...args], { encoding: 'utf8' }).trim();
  async function write(name, text) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  function commit() {
    git('add', '--all');
    git('commit', '--quiet', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  }
  git('init', '--quiet');
  for (const recipe of ['backend/Dockerfile', 'backend/Dockerfile.logistics-candidate']) {
    const contents = (await readFile(new URL('../' + recipe, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
    await write(recipe, contents);
    for (const line of contents.split('\n').filter(l => l.startsWith('COPY ') && !l.startsWith('COPY --from='))) {
      for (let source of line.split(/\s+/).slice(1, -1)) {
        source = source.replaceAll('*', 'contract');
        if (!path.extname(source)) source += '/nested/fixture.ts';
        await write(source, 'runtime input\n');
      }
    }
  }
  const api = commit();
  await write('web/src/fixture.ts', 'portal correction');
  await write('backend/tests/fixture.ts', 'test-only');
  const portal = commit();
  const measured = verifyRuntimeInputs(root, api, portal, image);
  assert.ok(measured.runtimeInputCount > 40);
  assert.match(measured.runtimeInputsSha256, /^[0-9a-f]{64}$/);
  assert.throws(() => verifyRuntimeInputs(root, api, portal, 'latest'), /immutable production/);
  for (const changed of ['backend/src/nested/fixture.ts', 'backend/scripts/new.d.mts', 'packages/evidence-contracts/nested/fixture.ts',
    'infra/backend-release/logistics-hosted-migration.mjs', '.dockerignore', 'backend/Dockerfile.logistics-candidate.dockerignore', 'backend/Dockerfile']) {
    git('checkout', '--quiet', '--detach', portal);
    await write(changed, 'changed input\n');
    const modified = commit();
    assert.throws(() => verifyRuntimeInputs(root, api, modified, image), /runtime Dockerfile|changes inputs/);
  }
});

test('the publisher requires the exact live API image, source, readiness and authentication boundary', async () => {
  const source = 'a'.repeat(40);
  function responses(change = {}) {
    return async url => {
      if (url.endsWith('/meta')) return Response.json({environment: 'production', commit: source, image, ...change.meta});
      if (url.endsWith('/ready')) return Response.json({status: change.ready ?? 'ready'});
      return new Response(null, {status: change.status ?? 401, headers: {'Access-Control-Allow-Origin': change.origin ?? target.web}});
    };
  }
  await verifyApiTarget(source, image, responses());
  for (const change of [{ meta: { image: image + '1' } }, { meta: { commit: 'b'.repeat(40) } },
    { meta: { environment: 'staging' } }, {ready: 'starting'}, {status: 200}, {origin: '*'}]) {
    await assert.rejects(verifyApiTarget(source, image, responses(change)));
  }
});

test('a recovery130 portal binds the actual recovery candidate recipe and rejects owner-CLI drift',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'portal-recovery-inputs-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',['-C',root,'-c','core.autocrlf=false','-c','user.name=tests','-c','user.email=tests@example.invalid',...args],{encoding:'utf8'}).trim();
  const write=async(name,text)=>{await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),text);};
  const commit=()=>{git('add','--all');git('commit','--quiet','-m','synthetic recovery fixture');return git('rev-parse','HEAD');};
  git('init','--quiet');
  for(const recipe of ['backend/Dockerfile','backend/Dockerfile.recovery-candidate']) {
    const contents=(await readFile(new URL('../'+recipe,import.meta.url),'utf8')).replaceAll('\r\n','\n');
    await write(recipe,contents);
    for(const line of contents.split('\n').filter(l=>l.startsWith('COPY ')&&!l.startsWith('COPY --from=')))
      for(let source of line.split(/\s+/).slice(1,-1)) {
        source=source.replaceAll('*','contract');if(!path.extname(source))source+='/nested/fixture.ts';
        await write(source,'runtime input\n');
      }
  }
  await write('backend/migrations/130_connect_recovery_collector_version.sql','fixture catalogue marker\n');
  const api=commit();await write('web/src/recovery.ts','matching portal');const portal=commit();
  assert.ok(verifyRuntimeInputs(root,api,portal,image).runtimeInputCount>40);
  for(const changed of ['infra/backend-release/recovery-hosted-migration.mjs','backend/Dockerfile.recovery-candidate']) {
    git('checkout','--quiet','--detach',portal);await write(changed,'different runtime input');
    assert.throws(()=>verifyRuntimeInputs(root,api,commit(),image),/runtime Dockerfile|changes inputs/);
  }
});
