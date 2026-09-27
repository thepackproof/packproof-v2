const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { required } = require('./check-acceptance.cjs');
const platforms = ['win32-x64', 'darwin-x64', 'darwin-arm64'];

function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--source', '--artifacts', '--out'].includes(key) || values[key] || !args[index + 1]) throw new Error('Use --source <40-character commit> --artifacts <downloaded artifact directory> --out <new kit directory>.');
    values[key] = args[index + 1];
  }
  if (!/^[a-f0-9]{40}$/.test(values['--source'] || '') || !values['--artifacts'] || !values['--out']) throw new Error('An exact source commit, artifact directory and new output directory are required.');
  return { sourceCommit: values['--source'], artifacts: path.resolve(values['--artifacts']), out: path.resolve(values['--out']) };
}
function findInventories(root) {
  const found = []; let visited = 0;
  function walk(directory, depth) {
    if (++visited > 200) throw new Error('Artifact directory is too broad. Select only the three downloaded candidate artifacts.');
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Artifact directories must not be symbolic links.');
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    if (entries.length > 500) throw new Error('Artifact directory contains too many entries.');
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Artifact input contains a symbolic link.');
      if (entry.name === 'release-evidence.json' && entry.isFile()) found.push(file);
      else if (entry.isDirectory() && depth < 3) walk(file, depth + 1);
    }
  }
  walk(root, 0);
  if (!found.length || found.length > 3) throw new Error('Provide one to three candidate release-evidence.json inventories.');
  return found;
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
async function inspectCandidates(root, sourceCommit) {
  const inventories = []; const seen = new Set(); let identity;
  for (const file of findInventories(root)) {
    if (fs.statSync(file).size > 5 * 1024 * 1024) throw new Error('Artifact inventory is too large.');
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    const platform = `${report.platform}-${report.arch}`;
    if (report.sourceCommit !== sourceCommit) throw new Error('Artifact inventory does not match the exact source commit.');
    if (!platforms.includes(platform) || seen.has(platform)) throw new Error('Unexpected or duplicate platform inventory.');
    if (!['development', 'staging', 'production'].includes(report.channel) || typeof report.signed !== 'boolean' || report.signed !== (report.channel !== 'development') || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(report.version || '')) throw new Error('Artifact inventory has invalid release identity.');
    const current = `${report.channel}/${report.version}`;
    if (identity && identity !== current) throw new Error('All candidate platforms must use the same channel and version.');
    identity = current; seen.add(platform);
    if (!Array.isArray(report.artifacts) || !report.artifacts.length || report.artifacts.length > 20) throw new Error('Artifact inventory has no bounded installer list.');
    const artifacts = [], names = new Set();
    for (const item of report.artifacts) {
      if (typeof item.file !== 'string' || !/^[a-zA-Z0-9 ._-]+\.(exe|dmg|zip|pkg)$/.test(item.file) || path.basename(item.file) !== item.file || names.has(item.file) || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || !Number.isSafeInteger(item.bytes) || item.bytes <= 0) throw new Error('Artifact inventory contains an invalid filename, hash or size.');
      names.add(item.file);
      const actual = path.join(path.dirname(file), item.file), stat = fs.lstatSync(actual);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.bytes || await hashFile(actual) !== item.sha256) throw new Error('Artifact bytes do not match the candidate inventory.');
      artifacts.push({ file: item.file, bytes: item.bytes, sha256: item.sha256 });
    }
    inventories.push({ platform: report.platform, arch: report.arch, version: report.version, channel: report.channel, signed: report.signed, inventory: path.relative(root, file), artifacts });
  }
  return { sourceCommit, inventories, missingPlatforms: platforms.filter(platform => !seen.has(platform)) };
}
async function prepareKit({ sourceCommit, artifacts, out }) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('An exact source commit is required.');
  if (fs.existsSync(out)) throw new Error('Output already exists; preserve its operator results and choose a new directory.');
  const candidate = await inspectCandidates(artifacts, sourceCommit);
  const template = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/release-acceptance.template.json'), 'utf8'));
  if (template.tests?.length !== required.length || required.some(id => !template.tests.some(test => test.id === id))) throw new Error('Acceptance template and required release gates disagree.');
  const report = { schemaVersion: template.schemaVersion, sourceCommit, approvedBy: '', testedAt: '', tests: required.map(id => ({ id, status: 'pending', evidence: '' })) };
  const worksheet = ['# Candidate acceptance worksheet', '', `Exact source: \`${sourceCommit}\``, '',
    `Candidate identity: ${candidate.inventories[0].channel} ${candidate.inventories[0].version}.`,
    `Missing platform inventories: ${candidate.missingPlatforms.join(', ') || 'none'}.`, '',
    'Hash verification identifies the supplied bytes; it does not establish a valid publisher signature, native installation, hardware behavior or acceptance. Every gate below is pending. Follow INSTALLED_ACCEPTANCE_KIT.md and retain redacted evidence. Do not reuse or enable disabled acceptance accounts.', '',
    '| Gate | Status | Windows evidence | Intel Mac evidence | Apple Silicon evidence |', '|---|---|---|---|---|',
    ...required.map(id => `| ${id} | pending | | | |`), '',
    'For each test record: OS/build, candidate SHA-256, hardware model, start/end time, operator, actions, observed result and evidence file reference. Record blocked or failed honestly. A gate can pass only when all its required platform/behavior coverage is supported. An accountable reviewer completes release-acceptance.json after reviewing those records.', '',
    'No passwords, tokens, customer recordings, protected credential-store files or unredacted diagnostics belong in this kit.', ''].join('\n');
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'candidate-manifest.json'), JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), ...candidate, acceptance: 'not-executed' }, null, 2) + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(out, 'release-acceptance.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(out, 'WORKSHEET.md'), worksheet, { mode: 0o600 });
  fs.copyFileSync(path.join(__dirname, '../docs/INSTALLED_ACCEPTANCE_KIT.md'), path.join(out, 'INSTALLED_ACCEPTANCE_KIT.md'));
  return { platforms: candidate.inventories.length, missingPlatforms: candidate.missingPlatforms, pendingGates: required.length };
}
module.exports = { parseArguments, inspectCandidates, prepareKit };
if (require.main === module) Promise.resolve().then(() => prepareKit(parseArguments(process.argv.slice(2)))).then(result => console.log(JSON.stringify({ prepared: true, ...result, testsExecuted: 0 }))).catch(error => { console.error(error.message); process.exitCode = 1; });
