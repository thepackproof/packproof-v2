#!/usr/bin/env node
/** Fail-closed Linux decoder launcher. No host root, home, network or credentials are mounted. */
import {spawnSync} from 'node:child_process';
import {realpathSync,statSync,lstatSync,existsSync,readFileSync} from 'node:fs';
import {resolve,dirname,basename,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
export function nativeLibraryAliasMounts(fs={existsSync,realpathSync,statSync}) {
 const mounts=[];
 // Debian/Ubuntu public BLAS libraries use these alternative links. Binding
 // the resolved library at the exact alias repairs loader resolution without
 // exposing /etc/alternatives or any additional host configuration directory.
 for(const architecture of ['x86_64-linux-gnu','aarch64-linux-gnu'])for(const library of ['libblas.so.3','liblapack.so.3']) {
  const alias=`/etc/alternatives/${library}-${architecture}`;
  if(!fs.existsSync(alias))continue;
  const target=fs.realpathSync(alias);
  if(!(target.startsWith('/usr/lib/')||target.startsWith('/lib/'))||!fs.statSync(target).isFile())throw new Error('Unsupported native library alias.');
  mounts.push('--ro-bind',target,alias);
 }
 return mounts;
}
export function sandboxCommand(argv) {
 if(process.platform!=='linux')throw new Error('Linux namespaces are required.');
 if(!Array.isArray(argv)||argv.some(v=>typeof v!=='string'||v.includes('\0')))throw new Error('Invalid sandbox arguments.');
 const split=argv.indexOf('--');if(split!==4||argv[0]!=='--runtime'||argv[2]!=='--code')throw new Error('Use --runtime /private/venv --code /repo/research -- python script arguments');
 const runtime=realpathSync(argv[1]),code=realpathSync(argv[3]),[program,script,...args]=argv.slice(split+1);
 if(!program||!script||!existsSync(resolve(runtime,'pyvenv.cfg'))||dirname(resolve(program))!==resolve(runtime,'bin')||!/^python(?:3(?:\.\d+)?)?$/.test(basename(program))||!statSync(program).isFile())throw new Error('Only the isolated Python environment can run.');
 // setup-python virtual environments point into /opt/hostedtoolcache. Mount
 // only that interpreter installation, not /opt or a user home wholesale.
 const homes=readFileSync(resolve(runtime,'pyvenv.cfg'),'utf8').split(/\r?\n/).filter(line=>/^home\s*=/.test(line));
 if(homes.length!==1)throw new Error('Python base installation is required.');
 const home=realpathSync(homes[0].slice(homes[0].indexOf('=')+1).trim());
 const base=dirname(home),executable=realpathSync(program);
 if(basename(home)!=='bin'||!(base==='/usr'||base.startsWith('/usr/')||base.startsWith('/opt/'))||!(executable.startsWith(home+sep)||executable.startsWith(resolve(runtime,'bin')+sep)))throw new Error('Unsupported Python base installation.');
 const scriptPath=realpathSync(script);
 const relative=scriptPath.slice(code.length+1);
 if(!scriptPath.startsWith(code+sep)||!['vision/worker.py','privacy/redact.py'].includes(relative))throw new Error('Only the pinned vision or redaction entry point is allowed.');
 let jobPath;
 if(relative==='vision/worker.py') {
  if(args.length!==4||args[0]!=='--job'||args[2]!=='--output')throw new Error('An exact vision job and output directory are required.');
  jobPath=args[1];
 } else {
  if(args.length!==8||args[0]!=='create'||args[3]!=='--masks'||args[5]!=='--kind'||!['still','video'].includes(args[6])||args[7]!=='--unsigned-record')throw new Error('Only an unsigned server-owned redaction job is allowed.');
  jobPath=args[1];
 }
 if(!jobPath||!jobPath.startsWith('/tmp/packproof-rnd-'))throw new Error('A private materialized job is required.');
 const job=realpathSync(dirname(jobPath)),info=statSync(job);
 if(dirname(job)!=='/tmp'||!/^packproof-rnd-[a-zA-Z0-9]+$/.test(basename(job))||!info.isDirectory()||(info.mode&0o077)!==0||info.uid!==process.getuid())throw new Error('Invalid job isolation directory.');
 const input=file=>{const detail=lstatSync(file);if(dirname(resolve(file))!==job||realpathSync(file)!==resolve(file)||!detail.isFile()||detail.nlink!==1)throw new Error('Only private job input files are allowed.');};
 input(jobPath);
 if(relative==='vision/worker.py') {
  if(resolve(args[3])!==job)throw new Error('Output must stay in the private job.');
 } else {
  input(args[4]);
  if(dirname(resolve(args[2]))!==job||existsSync(args[2]))throw new Error('A new derivative inside the private job is required.');
 }
 const mounts=['--unshare-all','--die-with-parent','--new-session','--clearenv','--cap-drop','ALL','--proc','/proc','--dev','/dev','--tmpfs','/tmp'];
 for(const directory of ['/usr','/lib','/lib64'])if(existsSync(directory))mounts.push('--ro-bind',directory,directory);
 for(const file of ['/etc/ld.so.cache','/etc/fonts'])if(existsSync(file))mounts.push('--ro-bind',file,file);
 mounts.push(...nativeLibraryAliasMounts());
 if(!base.startsWith('/usr/')&&base!=='/usr')mounts.push('--ro-bind',base,base);
 mounts.push('--ro-bind',runtime,runtime,'--ro-bind',code,code,'--bind',job,job,'--chdir',job,
  '--setenv','PATH','/usr/bin:/bin','--setenv','HOME',job,'--setenv','TMPDIR','/tmp',
  '--setenv','PYTHONNOUSERSITE','1','--setenv','PYTHONDONTWRITEBYTECODE','1',
  '--setenv','OMP_NUM_THREADS','1','--setenv','OPENBLAS_NUM_THREADS','1',
  '--','/usr/bin/prlimit','--as=2147483648','--cpu=55','--fsize=134217728','--nofile=128','--',program,scriptPath,...args);
 return {program:'/usr/bin/bwrap',args:mounts};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try{const command=sandboxCommand(process.argv.slice(2));const result=spawnSync(command.program,command.args,{stdio:'inherit',shell:false,timeout:60000,killSignal:'SIGKILL',env:{PATH:'/usr/bin:/bin'}});if(result.error)throw result.error;process.exitCode=result.status??1;}
 catch{process.stderr.write('RND_SANDBOX_UNAVAILABLE: configured containment could not run.\n');process.exitCode=1;}
}
