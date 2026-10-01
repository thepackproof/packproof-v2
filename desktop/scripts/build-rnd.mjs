import {spawnSync} from 'node:child_process';
const target = process.argv[2] ?? 'build';
if (!['build', 'win', 'mac'].includes(target) || process.argv.length > 3) throw new Error('Use build-rnd.mjs [build|win|mac]');
const env = {...process.env, APP_ENV:'research', PACKPROOF_SURFACE_REVIEW_ENABLED:'true', CSC_IDENTITY_AUTO_DISCOVERY:'false', PACKPROOF_BUILD_PKG:'1'};
for (const name of ['PACKPROOF_UPDATES_URL','PACKPROOF_SENTRY_DSN','SENTRY_DSN','PACKPROOF_COGNITO_CLIENT_ID','PACKPROOF_COGNITO_USER_POOL_ID','WIN_CSC_LINK','WIN_CSC_KEY_PASSWORD','CSC_LINK','CSC_KEY_PASSWORD','APPLE_ID','APPLE_API_KEY','APPLE_APP_SPECIFIC_PASSWORD','CSC_INSTALLER_LINK','CSC_INSTALLER_KEY_PASSWORD']) delete env[name];
const run=(command,args)=>{const result=spawnSync(command,args,{env,stdio:'inherit',shell:process.platform==='win32'});if(result.status!==0)process.exit(result.status??1);};
run('npm',['run','build']);
if(target!=='build')run('npx',['--no-install','electron-builder','--config','electron-builder.config.cjs',`--${target}`,'--publish','never']);
