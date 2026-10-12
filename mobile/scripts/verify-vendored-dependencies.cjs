'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const manifest = require('../vendor/integrity.json');

function filesIn(directory, base = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected vendor symlink: ${absolute}`);
    return entry.isDirectory() ? filesIn(absolute, base) : [path.relative(base, absolute).replaceAll(path.sep, '/')];
  }).sort();
}
function verifyPackage(directory, expected) {
  const actual = filesIn(directory);
  const allowed = Object.keys(expected).sort();
  if (JSON.stringify(actual) !== JSON.stringify(allowed))
    throw new Error(`Unexpected or missing files in vendored dependency ${directory}`);
  for (const file of allowed) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex');
    if (hash !== expected[file]) throw new Error(`Vendored dependency integrity mismatch: ${directory}/${file}`);
  }
}
function verifyVendoredDependencies() {
  for (const [name, expected] of Object.entries(manifest.packages)) {
    const directory = path.join(root, 'vendor', name);
    verifyPackage(directory, expected);
    const installed = path.dirname(require.resolve(`${name}/package.json`, { paths: [root] }));
    verifyPackage(installed, expected);
    if (fs.realpathSync(installed) !== fs.realpathSync(directory))
      throw new Error(`Expected the reviewed local ${name} dependency`);
  }
  for (const [consumer, dependency] of [
    ['@expo/cli', 'node-forge'], ['@expo/code-signing-certificates', 'node-forge'], ['micromatch', 'braces'],
  ]) {
    const consumerPath = path.dirname(require.resolve(`${consumer}/package.json`, { paths: [root] }));
    const resolved = require.resolve(`${dependency}/package.json`, { paths: [consumerPath] });
    if (fs.realpathSync(path.dirname(resolved)) !== fs.realpathSync(path.join(root, 'vendor', dependency)))
      throw new Error(`${consumer} is not using the reviewed ${dependency} implementation`);
  }
}
module.exports = { verifyPackage, verifyVendoredDependencies };
if (require.main === module) {
  verifyVendoredDependencies();
  console.log('Verified local fork bytes and installed consumer resolution.');
}
