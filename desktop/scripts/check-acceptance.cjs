const fs = require('node:fs');

const required = [
  'windows-install-upgrade-uninstall', 'macos-intel-install-upgrade', 'macos-arm-install-upgrade',
  'authentication-refresh-logout-isolation', 'camera-permissions-disconnect', 'continuous-recording-valid-media',
  'live-barcode-and-usb-scanner', 'hash-upload-commit-manifest', 'offline-reconnect-and-restart',
  'machine-restart-and-disk-full', 'expired-upload-authorization', 'marketplace-orders-and-tracking',
  'signed-updater-preserves-queue', 'capture-not-interrupted-by-update', 'high-dpi-and-accessibility',
  'recording-upload-soak', 'privacy-review', 'centralized-error-reporting-delivery',
];

function validateAcceptance(report, expectedCommit) {
  if (!expectedCommit || report.sourceCommit !== expectedCommit) throw new Error('Release acceptance must identify the exact source commit.');
  if (!report.approvedBy || !report.testedAt || !Number.isFinite(Date.parse(report.testedAt))) throw new Error('Release acceptance requires an accountable reviewer and test date.');
  for (const id of required) {
    const test = report.tests?.find(test => test.id === id);
    if (!test || test.status !== 'passed' || !test.evidence?.trim()) throw new Error(`Release acceptance incomplete: ${id}`);
  }
  return true;
}

module.exports = { required, validateAcceptance };
if (require.main === module) {
  try {
    const report = JSON.parse(fs.readFileSync(process.argv[2] || 'release-acceptance.json', 'utf8'));
    validateAcceptance(report, process.env.GITHUB_SHA);
    console.log('Exact-commit release acceptance passed.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
