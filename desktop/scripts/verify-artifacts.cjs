const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { checkReleaseEnvironment } = require('./release-policy.cjs');

function command(executable, args, { quiet = false } = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${executable} verification failed${quiet ? '' : `: ${(result.stderr || result.stdout || '').slice(0, 2000)}`}`);
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

async function hash(file) {
  const sha = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) sha.update(chunk);
  return sha.digest('hex');
}

async function main() {
  const release = checkReleaseEnvironment({ checkRuntime: true });
  const signed = release.channel !== 'development';
  const output = path.resolve(release.outputDirectory);
  const files = fs.readdirSync(output).filter(file => /\.(exe|dmg|zip|pkg)$/.test(file) && file.startsWith(release.artifactPrefix));
  const expected = release.platform === 'win32' ? ['exe'] : ['dmg', 'zip', ...(release.includePkg ? ['pkg'] : [])];
  for (const ext of expected) if (!files.some(file => file.endsWith(`.${ext}`))) throw new Error(`Missing ${ext} release artifact`);
  const checks = [];
  if (signed && release.platform === 'win32') {
    const binaries = [path.join(output, 'win-unpacked', `${release.productName}.exe`), ...files.filter(file => file.endsWith('.exe')).map(file => path.join(output, file))];
    for (const file of binaries) command('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'verify-windows-signature.ps1'), '-Artifact', file, '-Publisher', process.env.WINDOWS_PUBLISHER_NAME]);
    checks.push('authenticode-valid', 'publisher-matches', 'timestamp-valid');
  }
  if (signed && release.platform === 'darwin') {
    const appFolder = fs.readdirSync(output).find(name => name === (release.arch === 'arm64' ? 'mac-arm64' : 'mac'));
    if (!appFolder) throw new Error('Packaged macOS application is missing');
    const app = path.join(output, appFolder, `${release.productName}.app`);
    command('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    const details = command('codesign', ['--display', '--verbose=4', app]);
    if (!details.includes(`TeamIdentifier=${process.env.APPLE_TEAM_ID}`) || !details.includes('runtime')) throw new Error('Application signing team or hardened runtime is incorrect');
    command('xcrun', ['stapler', 'validate', app]);
    command('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
    for (const file of files) {
      const full = path.join(output, file);
      if (file.endsWith('.dmg')) command('xcrun', ['stapler', 'validate', full]);
      if (file.endsWith('.pkg')) {
        const details = command('pkgutil', ['--check-signature', full]);
        if (!details.includes(`(${process.env.APPLE_TEAM_ID})`)) throw new Error('Installer signing team is incorrect');
        command('xcrun', ['stapler', 'validate', full]);
        command('spctl', ['--assess', '--type', 'install', '--verbose=4', full]);
      }
    }
    checks.push('codesign-valid', 'apple-team-matches', 'hardened-runtime', 'notarized', 'stapled', 'gatekeeper-accepted');
  }
  // Aliases are convenient download names. Updater metadata continues using immutable versioned names.
  for (const ext of ['exe', 'dmg', 'pkg']) {
    const file = files.find(name => name.endsWith(`.${ext}`));
    if (!file) continue;
    const alias = `${release.artifactPrefix}${ext === 'exe' ? '-Setup' : ''}.${ext}`;
    if (file !== alias) { fs.copyFileSync(path.join(output, file), path.join(output, alias)); files.push(alias); }
  }
  const artifacts = [];
  for (const file of [...new Set(files)].sort()) artifacts.push({ file, bytes: fs.statSync(path.join(output, file)).size, sha256: await hash(path.join(output, file)) });
  const report = {
    schemaVersion: 1, version: require('../package.json').version, sourceCommit: process.env.GITHUB_SHA || null,
    channel: release.channel, platform: release.platform, arch: release.arch, signed, checks,
    updateUrl: signed ? release.updateUrl : null,
    hardwareAcceptance: 'not-established-by-this-build', artifacts,
  };
  fs.writeFileSync(path.join(output, 'release-evidence.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(output, 'SHA256SUMS'), artifacts.map(item => `${item.sha256}  ${item.file}\n`).join(''));
  if (!signed) fs.writeFileSync(path.join(output, 'DEVELOPMENT-BUILD.txt'), 'Development build without a verified publisher. Windows is unsigned; macOS uses an ad-hoc signature and is not notarized. Separate application data and protocol. Not approved for production evidence capture or customer distribution.\n');
  console.log(`Verified ${artifacts.length} desktop artifacts for ${release.channel}/${release.platform}/${release.arch}.`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
