import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// npm audits the local fork under its own name. Also ask the same advisory
// service about every unmodified parent release so new advisories still surface.
const versions = ['2.3.2', '3.0.2', '4.0.7'];
const reviewed = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf';
const work = mkdtempSync(path.join(tmpdir(), 'packproof-upstream-audit-'));
try {
  const project = { name: 'packproof-upstream-audit', version: '1.0.0', private: true, dependencies: {} };
  const packages = { '': project };
  for (const version of versions) {
    const alias = 'upstream-' + version[0];
    project.dependencies[alias] = 'npm:picomatch@' + version;
    packages['node_modules/' + alias] = { name: 'picomatch', version };
  }
  writeFileSync(path.join(work, 'package.json'), JSON.stringify(project));
  writeFileSync(path.join(work, 'package-lock.json'), JSON.stringify({ ...project, lockfileVersion: 3, packages }));
  const result = spawnSync('npm', ['audit', '--package-lock-only', '--json'], {
    cwd: work, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const report = JSON.parse(result.stdout);
  assert.ok([0, 1].includes(result.status) && report.auditReportVersion === 2 && report.vulnerabilities && !report.error,
    'The upstream dependency audit did not complete');
  assert.equal(report.metadata?.dependencies?.total, versions.length, 'An upstream version was omitted');
  const severe = new Set();
  for (const finding of Object.values(report.vulnerabilities)) {
    for (const advisory of finding.via || []) {
      if (typeof advisory !== 'object') continue;
      if (advisory.url !== reviewed && ['high', 'critical'].includes(advisory.severity)) severe.add(advisory.url);
    }
  }
  if (severe.size) throw new Error('Additional upstream advisory requires remediation: ' + [...severe].join(', '));
  console.log('Checked npm advisories for upstream picomatch ' + versions.join(', ') + '. Reviewed local fix: ' + reviewed);
} finally {
  rmSync(work, { recursive: true, force: true });
}
