// EAS uploads this profile environment to its worker; runner-only variables do
// not survive the remote prebuild. Do not change persistent EAS environment data.
const fs = require('node:fs');

function configureIosStoreBuild(config, env = process.env) {
  const source = env.EXPO_PUBLIC_PACKPROOF_BUILD_SHA;
  const number = env.PACKPROOF_IOS_BUILD_NUMBER;
  if (!/^[a-f0-9]{40}$/.test(source || '') || source !== env.GITHUB_SHA) throw new Error('Expected the exact workflow source revision.');
  if (!/^[1-9]\d*$/.test(number || '') || !Number.isSafeInteger(Number(number)) || Number(number) <= 5) throw new Error('Expected an iOS build number greater than 5.');
  const profile = config.build?.['ios-testflight'];
  if (profile?.distribution !== 'store' || profile.ios?.credentialsSource !== 'remote' || profile.ios?.autoIncrement !== false) throw new Error('Unexpected iOS signing profile.');
  profile.env = { ...profile.env, PACKPROOF_IOS_BUILD_NUMBER: number,
    PACKPROOF_EXPECTED_SOURCE_SHA: source, EXPO_PUBLIC_PACKPROOF_BUILD_SHA: source };
  return config;
}

if (require.main === module) {
  const config = configureIosStoreBuild(JSON.parse(fs.readFileSync('eas.json', 'utf8')));
  fs.writeFileSync('eas.json', JSON.stringify(config, null, 2) + '\n');
}

module.exports = { configureIosStoreBuild };
