import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {WorkspaceNotifications,type WorkspaceNotice} from '../src/main/workspace-notifications';
import {DesktopApi} from '../src/main/api';
import type {DesktopConfig} from '../src/main/config';
import type {CommerceConnectionView,ProofCollectionItem} from '../../web/src/api/types';

const proof=(id:string)=>({proofId:id,transaction:{itemTitle:'PRIVATE ITEM',trackingNumber:'PRIVATE TRACKING'}} as ProofCollectionItem);
const connection=(error:string|null)=>({connectionId:'private-connection',status:'ACTIVE',lastErrorCode:error,externalAccountReference:'PRIVATE STORE'} as CommerceConnectionView);
describe('main-process workspace notifications',()=>{
  const monitors:WorkspaceNotifications[]=[];
  beforeEach(()=>vi.useFakeTimers());afterEach(()=>{monitors.forEach(m=>m.stop());monitors.length=0;vi.useRealTimers();});
  function harness(){
    let proofs=[proof('initial-attention')],connections=[connection('INITIAL_ERROR')];
    const notices:WorkspaceNotice[]=[];
    const listAttention=vi.fn(async()=>proofs),listConnections=vi.fn(async()=>({connections}));
    const monitor=new WorkspaceNotifications({listAttention,listConnections,notify:notice=>notices.push(notice)});monitors.push(monitor);
    return {monitor,notices,listAttention,listConnections,proofs:(value:ProofCollectionItem[])=>{proofs=value;},connections:(value:CommerceConnectionView[])=>{connections=value;}};
  }
  it('polls while idle, suppresses the initial snapshot, and aggregates/de-duplicates attention transitions',async()=>{
    const h=harness();h.monitor.setAccount('account-a');await vi.advanceTimersByTimeAsync(0);
    expect(h.notices).toEqual([]);expect(h.listAttention).toHaveBeenCalledTimes(1);
    h.proofs([proof('initial-attention'),proof('new-one'),proof('new-two')]);await vi.advanceTimersByTimeAsync(120000);
    expect(h.notices).toEqual([{title:'PackProof Proofs need attention',message:'A shipment record needs action. Open Proofs to review it.'}]);
    await vi.advanceTimersByTimeAsync(240000);expect(h.notices).toHaveLength(1);
    h.proofs([]);await vi.advanceTimersByTimeAsync(120000);h.proofs([proof('new-one')]);await vi.advanceTimersByTimeAsync(120000);expect(h.notices).toHaveLength(2);
    expect(JSON.stringify(h.notices)).not.toMatch(/PRIVATE|new-one|account-a/);
  });
  it('de-duplicates both observed marketplace failures and explicit sync failures until recovery',async()=>{
    const h=harness();h.monitor.setAccount('account-a');await vi.advanceTimersByTimeAsync(0);
    h.monitor.syncFailed('account-a','private-connection');expect(h.notices).toEqual([]); // Already failed on baseline.
    h.connections([connection(null)]);await vi.advanceTimersByTimeAsync(120000);
    h.monitor.syncFailed('account-a','private-connection');h.monitor.syncFailed('account-a','private-connection');expect(h.notices).toHaveLength(1);
    h.connections([connection('PROVIDER_ERROR')]);await vi.advanceTimersByTimeAsync(120000);expect(h.notices).toHaveLength(1);
    h.monitor.syncSucceeded('account-a','private-connection');h.monitor.syncFailed('account-a','private-connection');expect(h.notices).toHaveLength(2);
    h.monitor.syncFailed('account-b','catalog');expect(h.notices).toHaveLength(2);
    h.monitor.syncFailed('account-a','catalog');h.monitor.syncFailed('account-a','catalog');expect(h.notices).toHaveLength(3);
    h.monitor.syncSucceeded('account-a','catalog');h.monitor.syncFailed('account-a','catalog');expect(h.notices).toHaveLength(4);
    expect(JSON.stringify(h.notices)).not.toMatch(/PRIVATE|PROVIDER_ERROR|private-connection/);
  });
  it('observes a new backend synchronization error during idle polling without a user sync request',async()=>{
    const h=harness();h.connections([connection(null)]);h.monitor.setAccount('account-a');await vi.advanceTimersByTimeAsync(0);
    h.connections([connection('TOKEN_EXPIRED')]);await vi.advanceTimersByTimeAsync(120000);expect(h.notices[0]?.title).toBe('Marketplace synchronization needs attention');
    await vi.advanceTimersByTimeAsync(120000);expect(h.notices).toHaveLength(1);
    h.connections([connection(null)]);await vi.advanceTimersByTimeAsync(120000);h.connections([connection('TOKEN_EXPIRED')]);await vi.advanceTimersByTimeAsync(120000);expect(h.notices).toHaveLength(2);
  });
  it('does not overlap polls and aborts/fences an old account before establishing the new baseline',async()=>{
    let resolve!:(rows:ProofCollectionItem[])=>void;let signal!:AbortSignal;
    const notices:WorkspaceNotice[]=[];
    const list=vi.fn((current:AbortSignal)=>{signal=current;return new Promise<ProofCollectionItem[]>(done=>{resolve=done;});});
    const monitor=new WorkspaceNotifications({listAttention:list,listConnections:async()=>({connections:[]}),notify:notice=>notices.push(notice)});monitors.push(monitor);
    monitor.setAccount('account-a');await vi.advanceTimersByTimeAsync(0);await vi.advanceTimersByTimeAsync(360000);
    expect(list).toHaveBeenCalledTimes(1);expect(signal.aborted).toBe(true);
    monitor.setAccount('account-b');resolve([proof('private-a')]);await vi.advanceTimersByTimeAsync(0);await vi.advanceTimersByTimeAsync(1);
    expect(notices).toEqual([]);expect(list).toHaveBeenCalledTimes(2);
    resolve([proof('private-b')]);await vi.advanceTimersByTimeAsync(0);expect(notices).toEqual([]);
    monitor.setAccount(null);await vi.advanceTimersByTimeAsync(360000);expect(list).toHaveBeenCalledTimes(2);
    monitor.syncFailed('account-b','catalog');expect(notices).toEqual([]);
  });
  it('keeps previous baselines through read failures and shuts down without further polling',async()=>{
    const h=harness();h.monitor.setAccount('account-a');await vi.advanceTimersByTimeAsync(0);
    h.listAttention.mockRejectedValueOnce(new Error('private request details'));h.listConnections.mockRejectedValueOnce(new Error('private provider details'));
    await vi.advanceTimersByTimeAsync(120000);expect(h.notices).toEqual([]);
    await vi.advanceTimersByTimeAsync(120000);expect(h.notices).toEqual([]);
    h.monitor.stop();const calls=h.listAttention.mock.calls.length;await vi.advanceTimersByTimeAsync(360000);expect(h.listAttention).toHaveBeenCalledTimes(calls);
    h.monitor.setAccount('account-c');h.monitor.syncFailed('account-c','catalog');expect(h.notices).toEqual([]);
  });
});

it('bounds authoritative attention pagination without returning a partial snapshot and propagates cancellation',async()=>{
  const fetcher=vi.fn(async(_url:string|URL|Request,_init?:RequestInit)=>new Response(JSON.stringify({proofs:[proof('private')],nextOffset:100}),{status:200}));
  const api=new DesktopApi({config:{apiBaseUrl:'https://api.example.invalid'} as DesktopConfig,getToken:async()=>'test-token',getAccountId:()=>'account-a',fetch:fetcher});
  await expect(api.listProofs({view:'attention',maxPages:1})).rejects.toMatchObject({code:'POLL_PAGE_LIMIT'});
  expect(fetcher).toHaveBeenCalledTimes(1);expect(String(fetcher.mock.calls[0]?.[0])).toContain('view=attention');
  const controller=new AbortController();controller.abort();await expect(api.listProofs({view:'attention',signal:controller.signal,maxPages:10})).rejects.toBeDefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
