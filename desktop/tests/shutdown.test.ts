import {describe,it,expect,vi} from 'vitest';
import {ShutdownCoordinator} from '../src/main/shutdown';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
async function microtasks(){for(let i=0;i<12;i++)await Promise.resolve();}
describe('safe native shutdown ordering',()=>{
  it('does not quit inside the original prevented close even when cleanup resolves in microtasks',async()=>{
    let nativeQuitting=false;const quit=vi.fn(()=>{nativeQuitting=true;});
    const shutdown=new ShutdownCoordinator({stop:()=>{},drain:async()=>{},closeReporting:async()=>{},quit,record:()=>{}});
    const request=shutdown.quit();
    // Electron's Emit drains microtasks before the surrounding native close handles preventDefault.
    await microtasks();expect(quit).not.toHaveBeenCalled();expect(shutdown.closeAllowed).toBe(false);
    nativeQuitting=false; // Browser::OnWindowCloseCancelled clears the original close's quit state.
    await request;
    expect(nativeQuitting).toBe(true);expect(quit).toHaveBeenCalledTimes(1);expect(shutdown.closeAllowed).toBe(true);
  });
  it('deduplicates repeated quit and updater preparation while guarding all evidence/reporting drains',async()=>{
    const evidence=deferred(),reporting=deferred();const stop=vi.fn(),drain=vi.fn(()=>evidence.promise),closeReporting=vi.fn(()=>reporting.promise),quit=vi.fn();
    const shutdown=new ShutdownCoordinator({stop,drain,closeReporting,quit,record:()=>{}});
    const first=shutdown.quit();expect(shutdown.quit()).toBe(first);expect(shutdown.prepare()).toBe(shutdown.prepare());
    await microtasks();expect(shutdown.inProgress).toBe(true);expect(shutdown.closeAllowed).toBe(false);expect(closeReporting).not.toHaveBeenCalled();
    evidence.resolve();await microtasks();expect(closeReporting).toHaveBeenCalledTimes(1);expect(shutdown.closeAllowed).toBe(false);expect(quit).not.toHaveBeenCalled();
    reporting.resolve();await microtasks();expect(shutdown.closeAllowed).toBe(false);expect(quit).not.toHaveBeenCalled();
    await first;expect(stop).toHaveBeenCalledTimes(1);expect(drain).toHaveBeenCalledTimes(1);expect(quit).toHaveBeenCalledTimes(1);
  });
  it('updater preparation permits close only after the next task and leaves installation to its caller',async()=>{
    const turn=deferred(),quit=vi.fn();const shutdown=new ShutdownCoordinator({stop:()=>{},drain:async()=>{},closeReporting:async()=>{},nextTurn:()=>turn.promise,quit,record:()=>{}});
    const pending=shutdown.prepare();await microtasks();expect(shutdown.closeAllowed).toBe(false);turn.resolve();await pending;expect(shutdown.closeAllowed).toBe(true);expect(quit).not.toHaveBeenCalled();
    shutdown.canceled();expect(shutdown.closeAllowed).toBe(false);expect(shutdown.inProgress).toBe(false);
  });
  it('failed or canceled preparation never permits native close or calls quit',async()=>{
    const quit=vi.fn(),record=vi.fn();const failed=new ShutdownCoordinator({stop:()=>{},drain:async()=>{throw Error('Unable to persist');},closeReporting:async()=>{},quit,record});
    await expect(failed.quit()).rejects.toThrow('Unable to persist');expect(failed.closeAllowed).toBe(false);expect(failed.inProgress).toBe(false);expect(record).toHaveBeenCalledWith('QUIT_FAILED');expect(quit).not.toHaveBeenCalled();
    const turn=deferred();const canceled=new ShutdownCoordinator({stop:()=>{},drain:async()=>{},closeReporting:async()=>{},nextTurn:()=>turn.promise,quit,record:()=>{}});
    const pending=canceled.quit();await microtasks();canceled.canceled();turn.resolve();await expect(pending).rejects.toThrow('canceled');expect(canceled.closeAllowed).toBe(false);expect(quit).not.toHaveBeenCalled();
  });
});
