import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
const spawn=vi.hoisted(()=>vi.fn());
vi.mock('node:child_process',async original=>({...await original<typeof import('node:child_process')>(),spawn}));
import {witnessStage} from '../src/rnd/worker.js';

let child:EventEmitter & {stdout:EventEmitter;stderr:EventEmitter;kill:ReturnType<typeof vi.fn>};
beforeEach(()=>{
 vi.useFakeTimers();spawn.mockReset();
 spawn.mockImplementation(()=>{
  child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter(),kill:vi.fn(()=>{queueMicrotask(()=>child.emit('close',null));return true;})});return child;
 });
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});

it('clears the stage timer on success and checks ownership both before and after',async()=>{
 const checkpoint=vi.fn().mockResolvedValue(60000),pending=witnessStage('synthetic',[],'APPEND',checkpoint);
 await vi.advanceTimersByTimeAsync(0);expect(spawn).toHaveBeenCalledTimes(1);
 child.stdout.emit('data',Buffer.from('{"valid":true}'));child.emit('close',0);
 expect(await pending).toBe('{"valid":true}');expect(checkpoint).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0);
});
it('caps process time at the remaining attempt budget and clears the timeout after termination',async()=>{
 const checkpoint=vi.fn().mockResolvedValue(250),pending=witnessStage('synthetic',[],'INCLUSION',checkpoint);
 const rejected=expect(pending).rejects.toMatchObject({code:'RND_WITNESS_INCLUSION_TIMEOUT'});
 await vi.advanceTimersByTimeAsync(250);await rejected;
 expect(child.kill).toHaveBeenCalledWith('SIGKILL');expect(checkpoint).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
});
it('starts no child after lease loss and discards a result when ownership was lost during a stage',async()=>{
 const lost=Object.assign(new Error('Lease lost'),{code:'RND_LEASE_LOST'});
 await expect(witnessStage('synthetic',[],'OPERATOR',vi.fn().mockRejectedValue(lost))).rejects.toBe(lost);
 expect(spawn).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
 const checkpoint=vi.fn().mockResolvedValueOnce(60000).mockRejectedValueOnce(lost),pending=witnessStage('synthetic',[],'OPERATOR',checkpoint);
 const rejected=expect(pending).rejects.toBe(lost);await vi.advanceTimersByTimeAsync(0);child.emit('close',0);await rejected;
 expect(vi.getTimerCount()).toBe(0);
});
it('clears timers when the executable fails to start',async()=>{
 const pending=witnessStage('synthetic',[],'CHECKPOINT',async()=>60000),rejected=expect(pending).rejects.toMatchObject({code:'RND_WITNESS_CHECKPOINT_UNAVAILABLE'});
 await vi.advanceTimersByTimeAsync(0);child.emit('error',new Error('Synthetic unavailable'));await rejected;
 expect(vi.getTimerCount()).toBe(0);
});
