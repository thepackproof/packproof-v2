import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolveRuntimeConfig, STAGING_API_BASE_URL} from '../../mobile/src/runtime-config.ts';
const require = createRequire(import.meta.url);
const {releaseContext,checkReleaseEnvironment} = require('../../desktop/scripts/release-policy.cjs');
const root = new URL('../../', import.meta.url);
const researchEnv = {EXPO_PUBLIC_PACKPROOF_RND_BUILD:'true', EXPO_PUBLIC_PACKPROOF_AUTH_MODE:'dev'};
const mobileConfig = (overrides = {}) => spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require("./mobile/app.config.js").expo))'], {cwd:root, env:{PATH:process.env.PATH, ...researchEnv, ...overrides}, encoding:'utf8'});

test('native RND identity, deep links and update isolation',()=>{
 const result=mobileConfig(); assert.equal(result.status,0,result.stderr); const config=JSON.parse(result.stdout);
 assert.equal(config.name,'PackProof RND'); assert.equal(config.ios.bundleIdentifier,'com.packproof.mobile.rnd'); assert.equal(config.android.package,'com.packproof.mobile.rnd');
 assert.equal(config.scheme,'packproof-rnd'); assert.deepEqual(config.ios.associatedDomains,[]); assert.deepEqual(config.android.intentFilters,[]); assert.equal(config.updates.enabled,false);
 assert.equal(config.plugins.find(p=>Array.isArray(p)&&p[0]==='expo-build-properties')[1].android.usesCleartextTraffic,true);
 assert.ok(!config.plugins.some(p=>typeof p==='string'&&p.includes('order-share')));
 assert.equal(mobileConfig({EAS_BUILD_PROFILE:'ios-testflight'}).status,1);
 assert.equal(mobileConfig({EXPO_PUBLIC_PACKPROOF_API_BASE_URL:STAGING_API_BASE_URL}).status,1);
});
test('standalone Release JS still uses isolated development config and ignores saved overrides',()=>{
 const config=resolveRuntimeConfig({env:researchEnv,isRelease:true,cached:{apiBaseUrl:STAGING_API_BASE_URL,authMode:'cognito',cognitoClientId:'productionClient'}});
 assert.equal(config.apiBaseUrl,'http://127.0.0.1:3000'); assert.equal(config.authMode,'dev'); assert.equal(config.cognito.clientId,''); assert.equal(config.allowsApiOverride,false);
 for(const host of [STAGING_API_BASE_URL,'https://thepackproof.com','https://api.thepackproof.com','http://example.com']) assert.throws(()=>resolveRuntimeConfig({env:{...researchEnv,EXPO_PUBLIC_PACKPROOF_API_BASE_URL:host},isRelease:true}));
 assert.throws(()=>resolveRuntimeConfig({env:{...researchEnv,EXPO_PUBLIC_COGNITO_CLIENT_ID:'existing-client'},isRelease:true}));
});
test('desktop research identity cannot reuse installation, protocol or update feed',()=>{
 const research=releaseContext({APP_ENV:'research'},'win32','x64');
 const prod=releaseContext({APP_ENV:'production'},'win32','x64');
 assert.equal(research.productName,'PackProof RND'); assert.equal(research.appId,'com.thepackproof.desktop.research'); assert.equal(research.protocol,'packproof-rnd'); assert.equal(research.updateUrl,''); assert.notEqual(research.appId,prod.appId);
 assert.doesNotThrow(()=>checkReleaseEnvironment({env:{APP_ENV:'research'},platform:'linux'}));
 for(const key of ['PACKPROOF_UPDATES_URL','PACKPROOF_COGNITO_CLIENT_ID','CSC_LINK','APPLE_API_KEY']) assert.throws(()=>checkReleaseEnvironment({env:{APP_ENV:'research',[key]:'forbidden'},platform:'linux'}));
});
test('research workflow builds artifacts without deploy, submission, secrets or write credentials',()=>{
 const text=readFileSync(new URL('../../.github/workflows/rnd-fingerprint-builds.yml',import.meta.url),'utf8');
 assert.match(text,/branches: \[rnd\/stochastic-surface-2026-10-01\]/);
 assert.match(text,/--publish never/);
 assert.doesNotMatch(text,/secrets\.|id-token:\s*write|contents:\s*write|eas\s+(submit|update)|notarytool|publish-release|aws-actions|\/expo-auth|gh release/);
 const autoSubmit=readFileSync(new URL('../../.github/workflows/ios-submit-current-release.yml',import.meta.url),'utf8');
 assert.match(autoSubmit,/workflows: \["iOS"\]/); assert.match(autoSubmit,/head_branch == 'main'/); assert.match(autoSubmit,/head_sha == '[a-f0-9]{40}'/);
});
