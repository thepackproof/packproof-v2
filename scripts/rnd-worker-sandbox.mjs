#!/usr/bin/env node
/** Fail-closed Linux decoder launcher. No host root, home, network or credentials are mounted. */
import {spawnSync} from 'node:child_process';
import {realpathSync,statSync,existsSync} from 'node:fs';
import {resolve,dirname,basename,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
export function sandboxCommand(argv) {
 if(process.platform!=='linux')throw new Error('Linux namespaces are required.');
 const split=argv.indexOf('--');if(split!==4||argv[0]!=='--runtime'||argv[2]!=='--code')throw new Error('Use --runtime /private/venv --code /repo/research -- python script arguments');
 const runtime=realpathSync(argv[1]),code=realpathSync(argv[3]),[program,script,...args]=argv.slice(split+1);
 if(!existsSync(resolve(runtime,'pyvenv.cfg'))||!program.startsWith(runtime+sep+'bin'+sep)||!/^python(?:3(?:\.\d+)?)?$/.test(basename(program)))throw new Error('Only the isolated Python environment can run.');
 const scriptPath=realpathSync(script);
 const relative=scriptPath.slice(code.length+1);
 if(!scriptPath.startsWith(code+sep)||!['vision/worker.py','privacy/redact.py'].includes(relative))throw new Error('Only the pinned vision or redaction entry point is allowed.');
 const jobPath=relative==='vision/worker.py'?args[args.indexOf('--job')+1]:args[0]==='create'?args[1]:null;
 if(!jobPath||!jobPath.startsWith('/tmp/packproof-rnd-'))throw new Error('A private materialized job is required.');
 const job=realpathSync(dirname(jobPath)),info=statSync(job);
 if(dirname(job)!=='/tmp'||!/^packproof-rnd-[a-zA-Z0-9]+$/.test(basename(job))||!info.isDirectory()||(info.mode&0o077)!==0||info.uid!==process.getuid())throw new Error('Invalid job isolation directory.');
 const mounts=['--unshare-all','--die-with-parent','--new-session','--clearenv','--cap-drop','ALL','--proc','/proc','--dev','/dev','--tmpfs','/tmp'];
 for(const directory of ['/usr','/lib','/lib64'])if(existsSync(directory))mounts.push('--ro-bind',directory,directory);
 for(const file of ['/etc/ld.so.cache','/etc/fonts'])if(existsSync(file))mounts.push('--ro-bind',file,file);
 mounts.push('--ro-bind',runtime,runtime,'--ro-bind',code,code,'--bind',job,job,'--chdir',job,
  '--setenv','PATH','/usr/bin:/bin','--setenv','HOME',job,'--setenv','TMPDIR','/tmp',
  '--setenv','PYTHONNOUSERSITE','1','--setenv','PYTHONDONTWRITEBYTECODE','1',
  '--setenv','OMP_NUM_THREADS','1','--setenv','OPENBLAS_NUM_THREADS','1',
  '--','/usr/bin/prlimit','--as=2147483648','--cpu=55','--fsize=33554432','--nofile=128','--',program,scriptPath,...args);
 return {program:'/usr/bin/bwrap',args:mounts};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try{const command=sandboxCommand(process.argv.slice(2));const result=spawnSync(command.program,command.args,{stdio:'inherit',shell:false,timeout:60000,env:{PATH:'/usr/bin:/bin'}});if(result.error)throw result.error;process.exitCode=result.status??1;}
 catch(error){process.stderr.write(`RND_SANDBOX_UNAVAILABLE: ${error.message}\n`);process.exitCode=1;}
}
