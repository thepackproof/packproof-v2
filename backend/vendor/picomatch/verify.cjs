'use strict';

const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs');

const root = process.cwd();
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const consumers = Object.entries(lock.packages).filter(([location, pkg]) => location && [
  pkg.dependencies, pkg.optionalDependencies, pkg.peerDependencies,
].some(deps => deps && Object.hasOwn(deps, 'picomatch')));
assert.ok(consumers.length, 'Expected installed consumers of the matcher');

const checked = new Set();
for (const [location] of consumers) {
  const from = createRequire(path.join(root, location, 'package.json'));
  const identity = from.resolve('picomatch/package.json');
  const meta = from(identity);
  const original = lock.name === '@packproof/v2-mobile'
    ? (location.endsWith('/@expo/cli') ? '3.0.2' : '2.3.2') : '4.0.7';
  assert.equal(meta.name, '@packproof/picomatch', location);
  assert.equal(meta.version, original + '-packproof.1', location);
  if (checked.has(identity)) continue;
  checked.add(identity);

  const match = from('picomatch');
  assert.ok(match('**/*.{jpg,png}')('proofs/photo.jpg'));
  assert.ok(match('**.js')('src/app.js'));
  assert.ok(match('[!a].js')('a.js'));
  assert.ok(!match('[!a].js')('b.js'));
  assert.ok(!match('**/*.{jpg,png}')('proofs/photo.txt'));
  assert.ok(match('orders/[0-9]?.csv')('orders/47.csv'));
  assert.ok(!match('**/*.json')('.private/report.json'));
  assert.ok(match('orders/@(east|west).csv')('orders/east.csv'));
  assert.ok(match('records/+(invoice-*.csv)')('records/invoice-47.csv'));
  assert.ok(!match('records/+(invoice-*.csv)')('records/invoice-47.xml'));
  // Inspect compiler output on an ordinary filename rule; no timing or stress payloads.
  for (const options of [{}, { maxExtglobRecursion: false }]) {
    const tokens = match.parse('records/+(invoice-*.csv)', options).tokens;
    assert.equal(tokens.at(-1).output, ')', 'The wildcard segment must be compiled just once');
  }
}
console.log('Verified ' + checked.size + ' installed matcher copies used by ' + consumers.length + ' packages.');
