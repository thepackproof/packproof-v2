import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertResearchEndpoint } from '../../src/research/isolation';
import { resolveRuntimeConfig } from '../../src/runtime-config';
import { measureLuma, passiveChallengeWindow } from '../../src/research/capture-policy';
import { comparisonAvailable, resultLabel, sourceEvidenceId, type ResearchAnalysisRow } from '../../src/research/review-model';
import { canonicalize } from '../../../packages/evidence-contracts/contracts.mjs';

const mobile = fileURLToPath(new URL('../../', import.meta.url));
test('research endpoint rejects production, credentials, paths and lookalike loopback hosts', () => {
  for (const value of ['https://thepackproof.com', 'https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws', 'http://127.0.0.1.evil.test', 'http://localhost/api', 'http://user:password@localhost', 'file:///tmp/x', 'http://localhost/?proxy=https://thepackproof.com']) assert.throws(() => assertResearchEndpoint(value));
  for (const value of ['http://127.0.0.1:3000', 'http://10.0.2.2:3000', 'http://localhost:3000', 'http://[::1]:3000']) assert.equal(assertResearchEndpoint(value), value);
});
test('research runtime cannot restore cached production API or credentials', () => {
  const runtime = resolveRuntimeConfig({ isRelease: true, env: { EXPO_PUBLIC_PACKPROOF_RND: 'true' }, cached: { apiBaseUrl: 'https://thepackproof.com', authMode: 'cognito', cognitoUserPoolId: 'production' } });
  assert.equal(runtime.apiBaseUrl, 'http://127.0.0.1:3000'); assert.equal(runtime.authMode, 'dev'); assert.equal(runtime.cognito.userPoolId, ''); assert.equal(runtime.allowsApiOverride, false);
});
test('branch blocks distribution profiles even without an R&D environment flag', () => {
  for (const profile of ['ios-testflight', 'ios-device', 'internal-staging', 'shipping-integration']) {
    const result = spawnSync(process.execPath, ['-e', 'require("./app.config.js")'], { cwd: mobile, encoding: 'utf8', env: { ...process.env, EAS_BUILD_PROFILE: profile, EXPO_PUBLIC_PACKPROOF_RND: 'false' } });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /R&D branch cannot use distribution/);
  }
  const result = spawnSync(process.execPath, ['scripts/assert-release-allowed.cjs'], { cwd: mobile, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /submissions.*not authorized/);
});
test('isolated profile removes production deep links and uses distinct app identities', () => {
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require("./app.config.js").expo))'], { cwd: mobile, encoding: 'utf8', env: { ...process.env, EAS_BUILD_PROFILE: 'research-local', EXPO_PUBLIC_PACKPROOF_RND: 'true', EXPO_PUBLIC_PACKPROOF_API_BASE_URL: 'http://127.0.0.1:3000', EXPO_PUBLIC_PACKPROOF_AUTH_MODE: 'dev' } });
  assert.equal(result.status, 0, result.stderr); const config = JSON.parse(result.stdout);
  assert.equal(config.android.package, 'com.packproof.mobile.research'); assert.equal(config.ios.bundleIdentifier, 'com.packproof.mobile.research');
  assert.deepEqual(config.ios.associatedDomains, []); assert.deepEqual(config.android.intentFilters, []);
});
test('passive quality reports measurable sharpness and exposure without a trust score', () => {
  const plain = measureLuma(new Uint8Array(64).fill(127), 8, 8);
  assert.deepEqual(plain, { meanLuma: 127, sharpness: 0, saturationFraction: 0 });
  const striped = Uint8Array.from({ length: 64 }, (_, i) => i % 2 ? 255 : 0);
  assert.deepEqual(measureLuma(striped, 8, 8), { meanLuma: 1020 / 7, sharpness: 255, saturationFraction: 1 });
  assert.throws(() => measureLuma(new Uint8Array(4), 3, 3));
});
test('challenge policy refuses every active illumination command and expires promptly', () => {
  const passive = { mode: 'PASSIVE_LAB', activeIlluminationEnabled: false, commands: [], expiresAtMs: 20_000 };
  assert.equal(passiveChallengeWindow(passive, 1_000), 5_000);
  assert.equal(passiveChallengeWindow(passive, 19_999), 1);
  assert.equal(passiveChallengeWindow(passive, 20_000), 0);
  assert.throws(() => passiveChallengeWindow({ ...passive, commands: [{ torch: 1 }] }, 0));
  assert.throws(() => passiveChallengeWindow({ ...passive, activeIlluminationEnabled: true }, 0));
});
test('operational failure and unavailable comparison remain distinct from observed differences', () => {
  assert.doesNotMatch(resultLabel({ operationalState: 'FAILED', findingState: 'DIFFERENCE_OBSERVED' } as ResearchAnalysisRow), /difference/i);
  assert.equal(comparisonAvailable([]), false);
  assert.equal(comparisonAvailable([{ legId: 'OUTBOUND' }, { legId: 'OUTBOUND' }] as never), false);
  assert.equal(comparisonAvailable([{ legId: 'OUTBOUND' }, { legId: 'return' }] as never), true);
  assert.equal(sourceEvidenceId('rnd_source_ev_1'), 'ev_1'); assert.equal(sourceEvidenceId('https://private.example'), null);
});
test('native signing payload bytes use every shared JCS cross-language golden vector', () => {
  const vectors = JSON.parse(readFileSync(new URL('../../../packages/evidence-contracts/canonical-vectors.json', import.meta.url), 'utf8'));
  for (const vector of vectors.vectors) {
    assert.equal(canonicalize(vector.value), vector.canonical, vector.name);
    assert.equal(createHash('sha256').update(vector.canonical, 'utf8').digest('hex'), vector.sha256, vector.name);
  }
});

test('durable native sidecar transport limits inventory and refuses arbitrary file paths',async()=>{
 const {nativeSidecarFiles,SIDECAR_MAX_BYTES}=await import('../../src/research/sidecar-policy');
 const hash='a'.repeat(64),frame={fileName:'research-frame-0.pgm',sha256:hash,byteLength:123};
 assert.deepEqual(nativeSidecarFiles({acquisitionSha256:hash,journalSha256:hash},{schemaVersion:'packproof.native-acquisition.v1',frames:[frame]}).map(f=>f.fileName),['research-acquisition.json','research-frame-0.pgm','native-journal.jsonl']);
 for(const invalid of [{...frame,fileName:'../video.mp4'},{...frame,byteLength:SIDECAR_MAX_BYTES+1},{...frame,sha256:'fake'}])assert.throws(()=>nativeSidecarFiles({acquisitionSha256:hash},{schemaVersion:'packproof.native-acquisition.v1',frames:[invalid]}));
 assert.throws(()=>nativeSidecarFiles({acquisitionSha256:hash},{schemaVersion:'packproof.native-acquisition.v1',frames:[frame,frame]}));
 assert.deepEqual(nativeSidecarFiles({acquisitionSha256:null,journalSha256:null},null),[]);
});

test('privacy review binds exact committed artifact and recipe with bounded pixel masks',async()=>{
 const {reviewArtifacts,derivativeReviewBinding,privacyMask}=await import('../../src/research/review-model');
 const artifact={name:'redacted.png',mimeType:'image/png',sha256:'a'.repeat(64),byteLength:120};
 const envelope={feature:'proofshield',details:{artifacts:[{...artifact,name:undefined}],observations:[{record:{derivativeSha256:artifact.sha256,recipeSha256:'b'.repeat(64)}}]}} as never;
 const accepted=reviewArtifacts(envelope);assert.equal(accepted.length,1);
 assert.deepEqual(derivativeReviewBinding(envelope,accepted[0]),{artifactSha256:artifact.sha256,recipeSha256:'b'.repeat(64)});
 assert.equal(derivativeReviewBinding(envelope,{...accepted[0],sha256:'c'.repeat(64)}),null);
 assert.deepEqual(privacyMask('10, 20, 30, 40'),{x:10,y:20,width:30,height:40});
 for(const mask of ['-1,0,10,10','0,0,0,10','0,0,999999,1','1,2,3'])assert.throws(()=>privacyMask(mask));
});
