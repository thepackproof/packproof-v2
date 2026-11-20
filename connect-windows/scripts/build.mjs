import {build as bundle} from 'esbuild';
import {build as vite} from 'vite';
import {mkdir,writeFile,copyFile,cp,readFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {writeBuildProvenance} from './build-provenance.mjs';
const require=createRequire(import.meta.url),{context,validate,sourceCommit}=require('./release-policy.cjs');
process.chdir(fileURLToPath(new URL('../',import.meta.url)));
const c=validate();
const unified=process.env.PACKPROOF_UNIFIED_WINDOWS==='1';
await rm('dist/commerce',{recursive:true,force:true});
for (const generated of ['dist/main/host.cjs','dist/main/dashboard-preload.cjs']) await rm(generated,{force:true});
await mkdir('dist/main',{recursive:true});await mkdir('build',{recursive:true});
await copyFile('../desktop/build/icon.png','build/icon.png');
await mkdir('ui/public/brand',{recursive:true});await cp('../web/public/brand','ui/public/brand',{recursive:true});
await mkdir('ui/public/fonts',{recursive:true});await copyFile('../web/public/fonts/Inter-variable.ttf','ui/public/fonts/Inter-variable.ttf');await copyFile('../web/public/fonts/OFL-Inter.txt','ui/public/fonts/OFL-Inter.txt');
const runtime={channel:c.channel,apiBaseUrl:process.env.PACKPROOF_API_BASE_URL||'',webBaseUrl:process.env.PACKPROOF_WEB_BASE_URL||'https://thepackproof.com',updateUrl:c.updateUrl,publisher:process.env.WINDOWS_PUBLISHER_NAME||'',sourceCommit:sourceCommit()};
await writeFile('dist/main/runtime-config.json',JSON.stringify(runtime,null,2));
for(const name of ['index','preload',...(unified?['host']:[])])await bundle({entryPoints:[`main/${name==='host'?'index':name}.ts`],define:{__PACKPROOF_HOSTED__:String(unified&&name!=='index')},outfile:`dist/main/${name}.cjs`,bundle:true,platform:'node',target:'node24',format:'cjs',external:['electron','electron-updater'],sourcemap:false});
await vite({configFile:'vite.config.ts'});
if (unified) {
  await bundle({entryPoints:['main/dashboard-preload.ts'],outfile:'dist/main/dashboard-preload.cjs',bundle:true,platform:'node',target:'node24',format:'cjs',external:['electron']});
  execFileSync(process.execPath,['scripts/build.mjs'],{cwd:'../desktop',stdio:'inherit',env:{...process.env,APP_ENV:c.channel,PACKPROOF_UPDATES_URL:c.channel==='development'?'':c.updateUrl}});
  await cp('../desktop/dist/main','dist/commerce/main',{recursive:true});
  await cp('../desktop/dist/renderer','dist/commerce/renderer',{recursive:true});
}
// Fail packaging if the unified launcher, approved route, or Connect setup is missing.
// The separately required on-device Figma visual receipt is documented in the contract.
execFileSync(process.execPath,['scripts/verify-windows-ux-contract.cjs',unified?'--unified':'--connect'],{stdio:'inherit'});
const appPackage=JSON.parse(await readFile('package.json','utf8'));
const rules=JSON.parse(await readFile('../backend/src/records/connect-csv-rules.json','utf8'));
const serviceProject=await readFile('service/PackProof.Connect.Service.csproj','utf8');
const sourceDirty=!!execFileSync('git',['status','--porcelain','--untracked-files=all'],{encoding:'utf8'}).trim();
await writeBuildProvenance(process.cwd(),{sourceCommit:runtime.sourceCommit,sourceDirty,channel:c.channel,appVersion:appPackage.version,serviceVersion:serviceProject.match(/<Version>([^<]+)<\/Version>/)?.[1]||'not declared',bridgeProtocol:1,csvRules:rules.version,csvProfile:rules.profile});
