import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestPath = 'dist/main/build-provenance.json';

async function inventory(root, directory) {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const file = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw Error('Build provenance does not allow symbolic links');
    if (entry.isDirectory()) result.push(...await inventory(root, file));
    else if (entry.isFile() && file !== manifestPath) {
      const bytes = await readFile(resolve(root, file));
      result.push({ file, bytes: bytes.length, sha256: hash(bytes) });
    } else if (!entry.isFile()) throw Error('Build provenance encountered a non-file asset');
  }
  return result;
}

/** Records the actual built application bytes; the manifest never contains source rows or credentials. */
export async function createBuildProvenance(root, metadata) {
  if (!/^[a-f0-9]{40}$/.test(metadata.sourceCommit)) throw Error('Full source commit required');
  return {
    schema: 'packproof.connect-build/v1',
    ...metadata,
    assets: [...await inventory(root, 'dist/main'), ...await inventory(root, 'dist/renderer')],
  };
}

export async function writeBuildProvenance(root, metadata) {
  const result = await createBuildProvenance(root, metadata);
  await writeFile(resolve(root, manifestPath), JSON.stringify(result, null, 2) + '\n');
  return result;
}

/** Recompute every asset, so removed, added, or modified renderer/main files fail qualification. */
export async function verifyBuildProvenance(root, expected) {
  const manifest = JSON.parse(await readFile(resolve(root, manifestPath), 'utf8'));
  if (manifest.schema !== 'packproof.connect-build/v1' || manifest.sourceCommit !== expected.sourceCommit || manifest.channel !== expected.channel) throw Error('Build provenance does not match the candidate');
  if (expected.requireClean && manifest.sourceDirty !== false) throw Error('Release provenance requires clean committed source');
  const actual = [...await inventory(root, 'dist/main'), ...await inventory(root, 'dist/renderer')];
  if (JSON.stringify(actual) !== JSON.stringify(manifest.assets)) throw Error('Built application assets differ from their provenance');
  return manifest;
}

/** Read the packaged ASAR independently; stale/changed packaged renderer bytes cannot qualify. */
export async function verifyPackagedProvenance(archive, expected) {
  const asar = (await import('@electron/asar')).default;
  // ASAR traverses member directories using the host path separator. Manifest
  // names stay portable, but every member lookup must use native separators.
  const manifest = JSON.parse(asar.extractFile(archive, normalize(manifestPath)).toString('utf8'));
  const appPackage = JSON.parse(asar.extractFile(archive, normalize('package.json')).toString('utf8'));
  if (appPackage.version !== manifest.appVersion) throw Error('Packaged application version differs from its provenance');
  if (manifest.schema !== 'packproof.connect-build/v1' || manifest.sourceCommit !== expected.sourceCommit || manifest.channel !== expected.channel) throw Error('Packaged provenance does not match the candidate');
  if (expected.requireClean && manifest.sourceDirty !== false) throw Error('Release provenance requires clean committed source');
  const assets = [];
  for (const raw of asar.listPackage(archive)) {
    const file = raw.replaceAll('\\', '/').replace(/^\//, '');
    if (!file.startsWith('dist/main/') && !file.startsWith('dist/renderer/')) continue;
    const member = normalize(file);
    const info = asar.statFile(archive, member, false);
    if ('link' in info) throw Error('Packaged application assets cannot be symbolic links');
    if ('files' in info || file === manifestPath) continue;
    const bytes = asar.extractFile(archive, member);
    assets.push({ file, bytes: bytes.length, sha256: hash(bytes) });
  }
  const ordered = values => [...values].sort((a, b) => a.file.localeCompare(b.file, 'en'));
  if (JSON.stringify(ordered(assets)) !== JSON.stringify(ordered(manifest.assets))) throw Error('Packaged application assets differ from their provenance');
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, root, sourceCommit, channel, archive] = process.argv.slice(2);
  if (command !== 'verify' || !root || !sourceCommit || !channel || !archive) throw Error('Usage: build-provenance.mjs verify ROOT SOURCE_COMMIT CHANNEL APP_ASAR');
  const expected = { sourceCommit, channel, requireClean: channel !== 'development' };
  const local = await verifyBuildProvenance(root, expected);
  const packaged = await verifyPackagedProvenance(archive, expected);
  if (JSON.stringify(local) !== JSON.stringify(packaged)) throw Error('Packaged provenance differs from the candidate manifest');
  process.stdout.write('Connect application provenance verified.\n');
}
