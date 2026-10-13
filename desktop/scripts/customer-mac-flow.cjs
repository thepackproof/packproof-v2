'use strict';
// Operates the unchanged, signed production app on a disposable hosted Mac.
// Synthetic camera input replaces physical hardware only. No app API is mocked.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn, execFileSync} = require('node:child_process');
const {assertRunner, childEnvironment, verifyArtifacts, bundleInventory, assertBundleMatches, command} = require('./mac-installed-acceptance.cjs');
const {chromium} = require(path.join(process.env.CUSTOMER_TOOLS, 'node_modules/playwright'));
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const output = path.join(process.env.RUNNER_TEMP, 'customer-mac');
const app = '/Applications/PackProof.app';
const profile = path.join(os.homedir(),'Library/Application Support/PackProof');
const report = {schema:'packproof.native-customer-flow.v1', platform:'darwin', arch:process.arch, sourceCommit:'92eae98722e888a3517653f787bdfecf5b4a5d58', harnessCommit:process.env.GITHUB_SHA, startedAt:new Date().toISOString(), physicalDeviceChecks:'waived', syntheticCamera:true, steps:[]};
let current='initialization', browser, page, proc, mounted=false, owned=false;
const mount = path.join(process.env.RUNNER_TEMP,'customer-mac-mount');
async function step(id, fn) {current=id;const detail=await fn();report.steps.push({id,status:'passed',...detail});console.log(id+': passed');}
async function snapshot(name) {if(!page)return;await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});fs.writeFileSync(path.join(output,name+'.txt'),(await page.locator('body').innerText()).replace(/[A-Za-z0-9_-]{80,}/g,'[REDACTED]'));}
async function launch() {
  proc=spawn(path.join(app,'Contents/MacOS/PackProof'),['--remote-debugging-address=127.0.0.1','--remote-debugging-port=9222','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'],{env:childEnvironment(),stdio:'ignore'});
  for(let i=0;i<60;i++){try{const r=await fetch('http://127.0.0.1:9222/json/version');if(r.ok)break;}catch{}if(proc.exitCode!==null)throw new Error('NATIVE_APP_EXITED');await sleep(1000);}
  browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
  for(let i=0;i<30;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('packproof:'));if(page)break;await sleep(1000);}
  if(!page)throw new Error('TRUSTED_RENDERER_NOT_FOUND');
  page.setDefaultTimeout(45000);
  await page.waitForFunction(()=>Boolean(window.packproof));
}
async function quit(){if(browser){await browser.close().catch(()=>{});browser=null;}if(proc?.exitCode===null){try{execFileSync('/usr/bin/osascript',['-e','tell application "PackProof" to quit'],{stdio:'ignore',timeout:15000});}catch{}for(let i=0;i<15&&proc.exitCode===null;i++)await sleep(500);if(proc.exitCode===null)proc.kill('SIGTERM');}page=null;}
async function main(){
 fs.mkdirSync(output,{recursive:true});
 try{
  assertRunner();
  if(fs.existsSync(app)||fs.existsSync(profile))throw new Error('PREEXISTING_INSTALLATION_REFUSED');
  await step('verify-signed-live-candidate',async()=>{const candidate=await verifyArtifacts(path.join(process.env.RUNNER_TEMP,'signed-mac'),report.sourceCommit,process.arch);report.artifacts=candidate.artifacts;fs.mkdirSync(mount);command('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,candidate.dmg],'DMG_MOUNT_FAILED');mounted=true;command('/usr/bin/ditto',[path.join(mount,'PackProof.app'),app],'INSTALL_FAILED');owned=true;command('/usr/bin/codesign',['--verify','--deep','--strict',app],'SIGNATURE_FAILED');command('/usr/bin/xcrun',['stapler','validate',app],'STAPLE_FAILED');command('/usr/sbin/spctl',['--assess','--type','execute',app],'GATEKEEPER_FAILED');return{version:candidate.version,signature:'passed',notarization:'passed',gatekeeper:'passed'};});
  const baseline=await bundleInventory(app);
  await step('launch-native-production-renderer',async()=>{await launch();await page.getByRole('button',{name:'Sign in',exact:true}).waitFor();await snapshot('01-sign-in');const state=await page.evaluate(()=>window.packproof.system.state());if(state.environment!=='production'||!state.configured||!state.secureStorage)throw new Error('NATIVE_CONFIGURATION_REFUSED');return{production:true,secureStorage:true,configured:true,url:page.url()};});
  if(process.env.CUSTOMER_FLOW_CREDENTIALS){
    const credential=JSON.parse(process.env.CUSTOMER_FLOW_CREDENTIALS)['mac-'+process.arch];
    if(!credential)throw new Error('ISOLATED_ACCOUNT_REQUIRED');
    await step('sign-in-customer-ui',async()=>{await page.getByLabel('Email address',{exact:true}).fill(credential.email);await page.getByLabel('Password',{exact:true}).fill(credential.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('navigation',{name:'Main navigation'}).waitFor({timeout:90000});await snapshot('02-workspace');return{isolatedTestAccount:true};});
  }
  await step('verify-unchanged-installed-bytes',()=>assertBundleMatches(app,baseline));
  report.passed=true;
 }catch(error){report.passed=false;report.failure={step:current,code:/^[A-Z_]+$/.test(error.message||'')?error.message:'UI_STEP_FAILED'};await snapshot('failure').catch(()=>{});console.log(JSON.stringify(report.failure));}
 finally{await quit();if(owned){fs.rmSync(app,{recursive:true,force:true});fs.rmSync(profile,{recursive:true,force:true});}if(mounted)try{command('/usr/bin/hdiutil',['detach',mount],'UNMOUNT_FAILED');}catch{}report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'receipt.json'),JSON.stringify(report,null,2));}
 if(!report.passed)process.exitCode=1;
}
main().catch(()=>{console.error('NATIVE_CUSTOMER_HARNESS_FAILED');process.exitCode=1;});
