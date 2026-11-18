import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TARGET } from '../backend-release/backend-deployment-plan.mjs';
import { connectRuntimeBuildRequest } from '../backend-release/connect-runtime-release.mjs';
import { assetMap, matchAsset, target } from '../connect-portal-release.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Both deployed roles use this immutable 122 image. The bridge Dockerfile
// extends exactly that runtime, so preparing from a new predecessor needs review.
const predecessor = TARGET.repository + '@sha256:3722c462d1e35de35aea2bc94c71dc0a74a617e729d16da7baabe4e817d7cbf3';
const profiles = ['collector-hosted-bridge', 'reconstruction-v11'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const run = (name, args, options = {}) => execFileSync(name, args, { cwd: root, encoding: 'utf8', ...options });
const loadJson = async file => JSON.parse(await readFile(file, 'utf8'));

function buildRequest(profile, source, checksum) {
  return connectRuntimeBuildRequest({
    profile, sourceSha: source, archiveSha256: checksum,
    predecessorImages: [predecessor], sourceTransport: 'git-commit',
  });
}

async function inventory(directory, prefix = '') {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const name = prefix + entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await inventory(absolute, name + '/'));
    else if (entry.isFile()) {
      if (name !== 'rollout.json') files.push({ path: name, sha256: digest(await readFile(absolute)) });
    } else throw Error('Release packets must contain only regular files and directories.');
  }
  return files;
}

async function inspect(directory, source) {
  const zip = path.join(directory, 'backend.zip');
  const exact = JSON.parse(run('python3', ['infra/backend-release/backend-source-archive.py', source, zip, 'reconstruction-v11', '--verify']));
  const portal = await loadJson(path.join(directory, 'portal/release.json'));
  if (portal.commit !== source) throw Error('The portal and backend belong to different source commits.');
  const entries = assetMap(portal, true);
  const portalFiles = await inventory(path.join(directory, 'portal'));
  if (portalFiles.length !== entries.size + 1) throw Error('Unexpected files in the portal release.');
  for (const entry of entries.values()) matchAsset(await readFile(path.join(directory, 'portal', entry.path)), entry);
  for (const profile of profiles) {
    const request = await loadJson(path.join(directory, profile + '.json'));
    if (json(request) !== json(buildRequest(profile, source, exact.archiveSha256))) throw Error('The CodeBuild request differs for ' + profile);
  }
  const windows = await loadJson(path.join(root, 'connect-windows/package.json'));
  return { schema: 'packproof.connect-rollout/v1', version: windows.version, source, apiOrigin: target.api, webOrigin: target.web,
    migrationInventorySha256: exact.migrationInventorySha256, approvedPredecessorImage: predecessor,
    files: await inventory(directory) };
}

async function main() {
  const [action, target, expected] = process.argv.slice(2);
  const source = run('git', ['rev-parse', 'HEAD']).trim();
  if (!['prepare', 'verify'].includes(action) || !target || source !== expected) {
    throw Error('Use prepare|verify OUTPUT EXACT_CHECKED_OUT_COMMIT.');
  }
  const directory = path.resolve(target);
  if (action === 'verify') {
    const manifest = await loadJson(path.join(directory, 'rollout.json'));
    if (json(manifest) !== json(await inspect(directory, source))) throw Error('Release packet verification failed.');
  } else {
    if (run('git', ['status', '--porcelain']).trim()) throw Error('Prepare from a clean checkout of the selected release.');
    await mkdir(path.dirname(directory), { recursive: true });
    const temporary = await mkdtemp(path.join(path.dirname(directory), '.connect-release-'));
    try {
      run(process.execPath, ['infra/connect-portal-release.mjs', 'build'], { stdio: 'inherit' });
      await cp(path.join(root, 'web/dist'), path.join(temporary, 'portal'), { recursive: true });
      const zip = path.join(temporary, 'backend.zip');
      const archive = JSON.parse(run('python3', ['infra/backend-release/backend-source-archive.py', source, zip, 'reconstruction-v11']));
      for (const profile of profiles) {
        await writeFile(path.join(temporary, profile + '.json'), json(buildRequest(profile, source, archive.archiveSha256)));
      }
      for (const name of ['docs/windows-connect/LIVE_ROLLOUT.md', 'docs/windows-connect/releases/SIGNED_WINDOWS_ROLLOUT.md',
        'infra/backend-release/connect-hosted-rollout.md']) {
        await cp(path.join(root, name), path.join(temporary, name), { recursive: true });
      }
      await writeFile(path.join(temporary, 'rollout.json'), json(await inspect(temporary, source)));
      await rename(temporary, directory);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  console.log(json({ action, source, directory }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
