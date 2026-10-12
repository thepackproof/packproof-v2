const fs = require('node:fs');

const required = [
  'windows-install-upgrade-uninstall', 'macos-intel-install-upgrade', 'macos-arm-install-upgrade',
  'authentication-refresh-logout-isolation', 'camera-permissions-disconnect', 'continuous-recording-valid-media',
  'live-barcode-and-usb-scanner', 'hash-upload-commit-manifest', 'offline-reconnect-and-restart',
  'machine-restart-and-disk-full', 'expired-upload-authorization', 'marketplace-orders-and-tracking',
  'signed-updater-preserves-queue', 'capture-not-interrupted-by-update', 'high-dpi-and-accessibility',
  'recording-upload-soak', 'privacy-review', 'centralized-error-reporting-delivery',
];

function validatePlatformScope(value = 'all') {
  if (!['all', 'mac', 'windows'].includes(value)) throw new Error('Release platforms must be all, mac or windows.');
  return value;
}

function platformsForScope(value = 'all') {
  const scope = validatePlatformScope(value);
  return scope === 'mac' ? ['darwin/x64', 'darwin/arm64'] : scope === 'windows' ? ['win32/x64'] : ['win32/x64', 'darwin/x64', 'darwin/arm64'];
}

function requiredForScope(value = 'all') {
  const scope = validatePlatformScope(value);
  return required.filter(id => scope === 'all' || (scope === 'mac' ? id !== 'windows-install-upgrade-uninstall' : !['macos-intel-install-upgrade', 'macos-arm-install-upgrade'].includes(id)));
}

function validateAcceptance(report, expectedCommit, value = 'all') {
  const scope = validatePlatformScope(value);
  if (!report || typeof report !== 'object' || Array.isArray(report) || !expectedCommit || report.sourceCommit !== expectedCommit) throw new Error('Release acceptance must identify the exact source commit.');
  // Legacy records describe the original all-platform release only.
  if ((report.platforms === undefined ? 'all' : validatePlatformScope(report.platforms)) !== scope) throw new Error('Release acceptance platform scope does not match this promotion.');
  if (typeof report.approvedBy !== 'string' || !report.approvedBy.trim() || typeof report.testedAt !== 'string' || !Number.isFinite(Date.parse(report.testedAt))) throw new Error('Release acceptance requires an accountable reviewer and test date.');
  const gates = requiredForScope(scope), tests = new Map();
  if (!Array.isArray(report.tests)) throw new Error('Release acceptance tests are required.');
  for (const test of report.tests) {
    if (!test || typeof test !== 'object' || typeof test.id !== 'string' || tests.has(test.id)) throw new Error('Release acceptance contains an invalid or duplicate test.');
    tests.set(test.id, test);
  }
  for (const id of gates) {
    const test = tests.get(id);
    if (!test || test.status !== 'passed' || typeof test.evidence !== 'string' || !test.evidence.trim()) throw new Error(`Release acceptance incomplete: ${id}`);
  }
  if (tests.size !== gates.length || [...tests.keys()].some(id => !gates.includes(id))) throw new Error('Release acceptance tests do not match its platform scope.');
  return true;
}

module.exports = { required, validatePlatformScope, platformsForScope, requiredForScope, validateAcceptance };
if (require.main === module) {
  try {
    const report = JSON.parse(fs.readFileSync(process.argv[2] || 'release-acceptance.json', 'utf8'));
    validateAcceptance(report, process.env.GITHUB_SHA, process.env.PACKPROOF_RELEASE_PLATFORMS);
    console.log('Exact-commit release acceptance passed.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
