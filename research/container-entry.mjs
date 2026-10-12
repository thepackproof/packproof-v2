import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {initializeRuntime,prepareRuntime} from '../scripts/rnd-runtime.mjs';

const directory='/research/session';
if(!existsSync(directory))initializeRuntime(directory);
// Container startup deliberately inherits no optional worker or service settings.
const spec=prepareRuntime({directory},{});
const child=spawn(spec.program,spec.args,spec.options);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.once('error',error=>{console.error(error.message);process.exitCode=1;});
child.once('exit',code=>{process.exitCode=code??1;});
