import assert from 'node:assert/strict';
import test from 'node:test';
import {chmodSync,mkdirSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sandboxCommand,nativeLibraryAliasMounts} from './rnd-worker-sandbox.mjs';

test('native aliases expose only exact read-only public BLAS/LAPACK files',()=>{
 const alias='/etc/alternatives/libblas.so.3-x86_64-linux-gnu';
 const target='/usr/lib/x86_64-linux-gnu/blas/libblas.so.3.10.0';
 const fs={existsSync:path=>path===alias,realpathSync:()=>target,statSync:()=>({isFile:()=>true})};
 assert.deepEqual(nativeLibraryAliasMounts(fs),['--ro-bind',target,alias]);
 assert.deepEqual(nativeLibraryAliasMounts({...fs,existsSync:()=>false}),[]);
 for(const outside of ['/etc/private/key','/home/runner/token','/usr/library/secret'])assert.throws(()=>nativeLibraryAliasMounts({...fs,realpathSync:()=>outside}),/Unsupported native library alias/);
 assert.throws(()=>nativeLibraryAliasMounts({...fs,statSync:()=>({isFile:()=>false})}),/Unsupported native library alias/);
});

test('non-Linux hosts reject namespace containment explicitly',{skip:process.platform==='linux'},()=>{
 assert.throws(()=>sandboxCommand([]),/Linux namespaces/);
});

test('launcher enforces exact private job, interpreter and output boundaries',{skip:process.platform!=='linux'},t=>{
 const outer=mkdtempSync('/tmp/packproof-sandbox-unit-'),job=mkdtempSync('/tmp/packproof-rnd-');
 t.after(()=>{rmSync(outer,{recursive:true,force:true});rmSync(job,{recursive:true,force:true});});
 chmodSync(job,0o700);
 const runtime=join(outer,'runtime'),code=join(outer,'research');
 mkdirSync(join(runtime,'bin'),{recursive:true});mkdirSync(join(code,'vision'),{recursive:true});mkdirSync(join(code,'privacy'));
 writeFileSync(join(runtime,'pyvenv.cfg'),'home = /usr/bin\n');symlinkSync('/usr/bin/python3',join(runtime,'bin/python'));
 writeFileSync(join(code,'vision/worker.py'),'# synthetic fixture\n');writeFileSync(join(code,'privacy/redact.py'),'# synthetic fixture\n');
 writeFileSync(join(job,'job.json'),'{}');writeFileSync(join(job,'masks.json'),'[]');
 const prefix=['--runtime',runtime,'--code',code,'--',join(runtime,'bin/python')];
 const vision=[join(code,'vision/worker.py'),'--job',join(job,'job.json'),'--output',job];
 const command=sandboxCommand([...prefix,...vision]);assert.equal(command.program,'/usr/bin/bwrap');
 for(const flag of ['--unshare-all','--clearenv','--new-session','--die-with-parent'])assert(command.args.includes(flag));
 assert(!command.args.includes('--share-net'));
 assert.throws(()=>sandboxCommand([...prefix,vision[0],join(job,'job.json')]),/exact vision/);
 assert.throws(()=>sandboxCommand([...prefix,...vision.slice(0,-1),outer]),/Output/);
 assert.throws(()=>sandboxCommand([...prefix.slice(0,-1),join(runtime,'bin/../../python'),...vision]),/isolated Python/);
 chmodSync(job,0o755);assert.throws(()=>sandboxCommand([...prefix,...vision]),/isolation directory/);chmodSync(job,0o700);
 symlinkSync(join(job,'job.json'),join(job,'alias.json'));assert.throws(()=>sandboxCommand([...prefix,vision[0],'--job',join(job,'alias.json'),'--output',job]),/private job input/);
 const privacy=[join(code,'privacy/redact.py'),'create',join(job,'job.json'),join(job,'derivative.png'),'--masks',join(job,'masks.json'),'--kind','still','--unsigned-record'];
 assert.equal(sandboxCommand([...prefix,...privacy]).program,'/usr/bin/bwrap');
 assert.throws(()=>sandboxCommand([...prefix,...privacy,'--key',join(job,'key.pem')]),/unsigned server-owned/);
 writeFileSync(join(job,'derivative.png'),'existing');assert.throws(()=>sandboxCommand([...prefix,...privacy]),/new derivative/);
 writeFileSync(join(runtime,'pyvenv.cfg'),'home = /tmp\n');assert.throws(()=>sandboxCommand([...prefix,...vision]),/Unsupported Python/);
});
