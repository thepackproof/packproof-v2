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
const recoveryInventory = '13f05713808a4c077b9388d5609d99ad1bfa16b9ded82b2e447bc1c076d5896e';

export function packetProfile(latestMigration) {
  if (latestMigration === '130_connect_recovery_collector_version.sql') return 'recovery-v1';
  if (latestMigration === '124_connect_collector_version.sql') return 'reconstruction-v11';
  throw Error('The source does not match a reviewed release packet profile.');
}
function sourceProfile(source) {
  const files = run('git', ['ls-tree', '-r', '--name-only', source, '--', 'backend/migrations']).trim().split('\n')
    .filter(name => name.endsWith('.sql')).sort();
  return packetProfile(path.basename(files.at(-1) || ''));
}
export function recoveryPacketInput(source, exact) {
  if (!/^[a-f0-9]{40}$/.test(source) || exact.sourceSha !== source || exact.allGitBlobBytesVerified !== true ||
      exact.migrationCount !== 129 || exact.migrationInventorySha256 !== recoveryInventory || !/^[a-f0-9]{64}$/.test(exact.archiveSha256 || '')) {
    throw Error('The recovery packet requires exact verified source and the reviewed130 inventory.');
  }
  return { schema: 'packproof.connect-recovery-packet-input/v1', source, archiveProfile: 'recovery-v1',
    archiveSha256: exact.archiveSha256, migrationInventorySha256: exact.migrationInventorySha256,
    workflow: '.github/workflows/connect-recovery-release.yml', requestPath: 'infra/connect-rollout/recovery-promotion.json',
    firstPhase: 'inspect', requiresSuccessfulMainCI: true, requiresObservedPredecessor: true,
    requiresVersionedArchive: true, imagesBuilt: false, productionQualified: false };
}

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
  const profile = sourceProfile(source);
  const exact = JSON.parse(run('python3', ['infra/backend-release/backend-source-archive.py', source, zip, profile, '--verify']));
  const portal = await loadJson(path.join(directory, 'portal/release.json'));
  if (portal.commit !== source) throw Error('The portal and backend belong to different source commits.');
  const entries = assetMap(portal, true);
  const portalFiles = await inventory(path.join(directory, 'portal'));
  if (portalFiles.length !== entries.size + 1) throw Error('Unexpected files in the portal release.');
  for (const entry of entries.values()) matchAsset(await readFile(path.join(directory, 'portal', entry.path)), entry);
  if (profile === 'recovery-v1') {
    const planned = recoveryPacketInput(source, exact);
    if (json(await loadJson(path.join(directory, 'recovery-release.json'))) !== json(planned)) throw Error('Recovery coordinator input changed.');
    const files = await inventory(directory);
    if (files.some(file => !file.path.startsWith('portal/') && !['backend.zip', 'recovery-release.json',
      'infra/backend-release/CONNECT_RECOVERY_ROLLOUT.md'].includes(file.path))) throw Error('Unexpected recovery packet file.');
    // The predecessor and S3 object version come from later live inspection.
    // Never emit the historical122 bridge requests for a130 application.
    return { schema: 'packproof.connect-recovery-rollout/v1', source, apiOrigin: target.api, webOrigin: target.web,
      migrationInventorySha256: exact.migrationInventorySha256, coordinator: planned, files };
  }
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
      const profile = sourceProfile(source);
      const archive = JSON.parse(run('python3', ['infra/backend-release/backend-source-archive.py', source, zip, profile]));
      if (profile === 'recovery-v1') await writeFile(path.join(temporary, 'recovery-release.json'), json(recoveryPacketInput(source, archive)));
      else for (const legacy of profiles) {
        await writeFile(path.join(temporary, legacy + '.json'), json(buildRequest(legacy, source, archive.archiveSha256)));
      }
      const documents = profile === 'recovery-v1' ? ['infra/backend-release/CONNECT_RECOVERY_ROLLOUT.md'] :
        ['docs/windows-connect/LIVE_ROLLOUT.md', 'docs/windows-connect/releases/SIGNED_WINDOWS_ROLLOUT.md', 'infra/backend-release/connect-hosted-rollout.md'];
      for (const name of documents) {
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
