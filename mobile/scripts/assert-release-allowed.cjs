const fs = require('node:fs');
const path = require('node:path');
const marker = path.resolve(__dirname, '../../config/rnd/research-build.json');
if (fs.existsSync(marker)) {
  const policy = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (policy.researchOnly || !policy.distributionAllowed) {
    console.error('This branch is experimental R&D. Store builds, submissions and remote signing are not authorized. Use the local research profile.');
    process.exit(1);
  }
}
