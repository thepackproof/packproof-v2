const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

// This hook runs BEFORE artifactCreated and update-metadata hashing. Stapling changes bytes.
module.exports = async function notarizeDiskImage(event) {
  if (process.env.APP_ENV === 'development' || !process.env.APP_ENV || !event.file?.endsWith('.dmg')) return;
  if (process.platform !== 'darwin') throw new Error('Disk-image notarization requires macOS.');
  const env = process.env;
  const auth = env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER
    ? ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER]
    : ['--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', env.APPLE_TEAM_ID];
  const result = spawnSync('xcrun', ['notarytool', 'submit', event.file, '--wait', '--timeout', '25m', '--output-format', 'json', ...auth], { encoding: 'utf8' });
  // Do not echo credential arguments or Apple's diagnostic response into build logs.
  if (result.status !== 0 || JSON.parse(result.stdout).status !== 'Accepted') throw new Error('Apple did not accept the disk image for notarization.');
  for (const operation of ['staple', 'validate']) {
    const staple = spawnSync('xcrun', ['stapler', operation, event.file], { encoding: 'utf8' });
    if (staple.status !== 0) throw new Error(`Notarized disk-image ${operation} failed.`);
  }
  const sha = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(event.file)) sha.update(chunk);
  event.updateInfo = { sha512: sha.digest('base64'), size: fs.statSync(event.file).size };
};
