const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function safeDiagnostic(result, env) {
  let text = `${result.stdout || ''}\n${result.stderr || ''}`;
  for (const key of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) {
    if (env[key]) text = text.split(env[key]).join('[REDACTED]');
  }
  return text.trim().slice(-2000);
}

// Apple's ticket may not be available on every endpoint immediately after acceptance.
// Retry the same bytes; never turn a failed validation into a successful release.
async function stapleAndValidate(file, { run = spawnSync, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), env = process.env } = {}) {
  let failure;
  for (let attempt = 1; attempt <= 3; attempt++) {
    for (const operation of ['staple', 'validate']) {
      const result = run('xcrun', ['stapler', operation, file], { encoding: 'utf8' });
      if (result.status !== 0) {
        failure = new Error(`Notarized disk-image ${operation} failed (exit ${result.status ?? 'unknown'}, attempt ${attempt}/3): ${safeDiagnostic(result, env)}`);
        break;
      }
      if (operation === 'validate') return attempt;
    }
    if (attempt < 3) await wait(attempt * 10000);
  }
  throw failure;
}

// This hook runs BEFORE artifactCreated and update-metadata hashing. Stapling changes bytes.
module.exports = async function notarizeDiskImage(event) {
  if (process.env.APP_ENV === 'development' || !process.env.APP_ENV || !event.file?.endsWith('.dmg')) return;
  if (process.platform !== 'darwin') throw new Error('Disk-image notarization requires macOS.');
  const env = process.env;
  const auth = env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER
    ? ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER]
    : ['--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', env.APPLE_TEAM_ID];
  const result = spawnSync('xcrun', ['notarytool', 'submit', event.file, '--wait', '--timeout', '60m', '--output-format', 'json', ...auth], { encoding: 'utf8' });
  // Do not echo credential arguments or Apple's diagnostic response into build logs.
  if (result.status !== 0 || JSON.parse(result.stdout).status !== 'Accepted') throw new Error('Apple did not accept the disk image for notarization.');
  await stapleAndValidate(event.file);
  const sha = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(event.file)) sha.update(chunk);
  event.updateInfo = { sha512: sha.digest('base64'), size: fs.statSync(event.file).size };
};
module.exports.stapleAndValidate = stapleAndValidate;
