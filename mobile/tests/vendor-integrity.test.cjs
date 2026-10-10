'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { verifyPackage, verifyVendoredDependencies } = require('../scripts/verify-vendored-dependencies.cjs');

test('reviewed vendor bytes and all known parent resolutions match', () => {
  verifyVendoredDependencies();
  const lock = require('../package-lock.json');
  const packages = Object.entries(lock.packages);
  assert.equal(packages.some(([key]) => /(?:^|\/)node_modules\/sprintf-js$/.test(key)), false);
  assert.equal(packages.some(([key, value]) => /(?:^|\/)node_modules\/argparse$/.test(key) && value.version.startsWith('1.')), false);
  for (const [key, value] of packages) {
    if (key.endsWith('node_modules/braces') || key.endsWith('node_modules/node-forge')) {
      assert.equal(value.link, true, key);
      assert.match(value.resolved, /^vendor\/(braces|node-forge)$/);
    }
    if (key.endsWith('node_modules/js-yaml')) assert.equal(value.version, '4.3.2', key);
  }
  assert.throws(() => require.resolve('node-forge/dist/forge.min.js'), { code: 'MODULE_NOT_FOUND' });
  assert.throws(() => require.resolve('node-forge/dist/forge.all.min.js'), { code: 'MODULE_NOT_FOUND' });
});
test('vendor verification fails closed on changed bytes and unexpected files', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packproof-vendor-integrity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'module.js'), 'reviewed source');
  const expected = { 'module.js': crypto.createHash('sha256').update('reviewed source').digest('hex') };
  verifyPackage(dir, expected);
  fs.writeFileSync(path.join(dir, 'module.js'), 'unreviewed source');
  assert.throws(() => verifyPackage(dir, expected), /integrity mismatch/);
  fs.writeFileSync(path.join(dir, 'module.js'), 'reviewed source');
  fs.writeFileSync(path.join(dir, 'old-bundle.js'), 'stale');
  assert.throws(() => verifyPackage(dir, expected), /Unexpected or missing/);
});

test('both replaced YAML consumers use 4.3.2 and safe configuration schemas', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packproof-yaml-compat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const consumer of ['cosmiconfig', '@istanbuljs/load-nyc-config']) {
    const fromConsumer = createRequire(require.resolve(`${consumer}/package.json`));
    assert.equal(fromConsumer('js-yaml/package.json').version, '4.3.2');
    assert.equal(fromConsumer('js-yaml').load('flag: true\nvalue: null\ncount: 2\n').flag, true);
    assert.throws(() => fromConsumer('js-yaml').load('value: !!js/function "function () {}"'), /unknown tag/);
    assert.throws(() => fromConsumer('js-yaml').load('value: !!js/regexp /x/'), /unknown tag/);
  }
  const yamlPath = path.join(dir, 'metro.config.yaml');
  fs.writeFileSync(yamlPath, 'watchFolders: [src, shared]\nresetCache: true\nmaxWorkers: 2\nresolver:\n  sourceExts: [ts, tsx]\n');
  const found = require('cosmiconfig')('metro').loadSync(yamlPath);
  assert.deepEqual(found.config, { watchFolders: ['src', 'shared'], resetCache: true, maxWorkers: 2, resolver: { sourceExts: ['ts', 'tsx'] } });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true}');
  fs.writeFileSync(path.join(dir, '.nycrc.yaml'), 'all: true\ninclude: [src/**/*.ts]\nexclude: [tests/**]\nreporter: [text, lcov]\ncheck-coverage: true\n');
  const nyc = await require('@istanbuljs/load-nyc-config').loadNycConfig({ cwd: dir });
  assert.equal(nyc.all, true);
  assert.equal(nyc.checkCoverage, true);
  assert.deepEqual(nyc.include, ['src/**/*.ts']);
  assert.deepEqual(nyc.reporter, ['text', 'lcov']);
  fs.writeFileSync(yamlPath, 'bad: [\n');
  assert.throws(() => require('cosmiconfig')('metro').loadSync(yamlPath), /metro\.config\.yaml/);
});
