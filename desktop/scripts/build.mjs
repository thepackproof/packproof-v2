import {build as bundle} from 'esbuild';
import {build as vite} from 'vite';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
await mkdir('dist/main',{recursive:true});
// Reuse the same validated configuration in source builds and packaged runtime.
const configModule = await bundle({entryPoints:['src/main/config.ts'],bundle:true,platform:'node',target:'node24',format:'esm',write:false});
const {loadConfig} = await import('data:text/javascript;base64,' + Buffer.from(configModule.outputFiles[0].text).toString('base64'));
const config = loadConfig();
await writeFile('dist/main/runtime-config.json',JSON.stringify(config,null,2));
for(const name of ['index','preload'])await bundle({entryPoints:[`src/main/${name}.ts`],outfile:`dist/main/${name}.cjs`,bundle:true,platform:'node',target:'node24',format:'cjs',external:['electron','electron-updater','@sentry/node'],sourcemap:false});
await vite({configFile:path.join(root,'vite.config.ts')});
